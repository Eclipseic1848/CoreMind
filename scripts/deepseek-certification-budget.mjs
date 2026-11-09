export const DEEPSEEK_BILLING_CONTROL = "deepseek-flash-cny-reserved-v1";
export const DEEPSEEK_CERTIFICATION_OPTIONS = Object.freeze({
  maxTokens: 1024,
  thinkingLevel: "off",
});
export const DEEPSEEK_REQUEST_RESERVATION_MICROCNY = 2_105_344;

const ENDPOINT = "https://api.deepseek.com/chat/completions";
const CONTEXT_TOKENS = 1_048_576;
const MAX_EVENT_CHARS = 65_536;
const REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "max_tokens",
  "thinking",
  "n",
  "temperature",
  "top_p",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "reasoning_effort",
]);

/** 从数字的十进制表示向下取微元，避免浮点乘法把 1.000001 少算一微元。 */
export function toDeepSeekMicroCny(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("DeepSeek 认证人民币金额无效");
  }
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = Number(exponent) + 6 - fraction.length;
  const digits = BigInt(whole + fraction);
  const micro = scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale);
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("DeepSeek 认证人民币金额超界");
  return Number(micro);
}

/** 仅服务本次原生 DeepSeek 文本认证；费用预留不依赖缓存命中或取消退款。 */
export function createDeepSeekCertificationGuard({ maxCostCny, fetchImpl = globalThis.fetch }) {
  const budget = toDeepSeekMicroCny(maxCostCny);
  if (
    typeof maxCostCny !== "number" ||
    !Number.isFinite(maxCostCny) ||
    !Number.isSafeInteger(budget) ||
    budget <= 0 ||
    typeof fetchImpl !== "function"
  ) {
    throw new Error("DeepSeek 认证人民币预算无效");
  }
  let requests = 0;
  let settledRequests = 0;
  let reserved = 0;
  let settled = 0;
  let deniedRequests = 0;
  let invalidResponses = 0;
  let authenticationRejections = 0;
  const assertHealthy = () => {
    if (deniedRequests || invalidResponses) throw new Error("DeepSeek 认证费用边界已失败");
  };
  const deny = () => {
    deniedRequests += 1;
    return new Error("DeepSeek 认证请求未通过费用准入");
  };

  return {
    assertHealthy,
    snapshot: () => ({
      billingControl: DEEPSEEK_BILLING_CONTROL,
      currency: "CNY",
      maxCostCny,
      requests,
      settledRequests,
      retainedReservations: requests - settledRequests,
      settledCostCny: settled / 1_000_000,
      reservedCostCny: reserved / 1_000_000,
      exposureCny: (settled + reserved) / 1_000_000,
      deniedRequests,
      invalidResponses,
      authenticationRejections,
    }),
    fetch: async (input, init) => {
      let request;
      let text;
      let payload;
      try {
        request = new Request(input, init);
        text = await request.text();
        payload = JSON.parse(text);
        if (request.url !== ENDPOINT || request.method !== "POST" || !validPayload(payload)) {
          throw new Error("请求合同不匹配");
        }
      } catch {
        throw deny();
      }
      const signal = init?.signal ?? request.signal;
      signal?.throwIfAborted();
      // 准入与扣留之间没有 await；父、子及任何底层重复发送共用同一笔余额。
      if (
        deniedRequests ||
        invalidResponses ||
        budget - settled - reserved < DEEPSEEK_REQUEST_RESERVATION_MICROCNY
      ) {
        throw deny();
      }
      reserved += DEEPSEEK_REQUEST_RESERVATION_MICROCNY;
      requests += 1;
      const outbound = new Request(request, { body: text, redirect: "error" });
      const response = await fetchImpl(outbound, {
        ...init,
        body: text,
        signal,
        redirect: "error",
      });
      let invalid = false;
      const failResponse = () => {
        if (!invalid) invalidResponses += 1;
        invalid = true;
        return new Error("DeepSeek 认证响应缺少可信的完整账单");
      };
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw failResponse();
      }
      if (response.status === 401) authenticationRejections += 1;
      if (!response.ok) return response;
      if (
        !response.body ||
        !/^text\/event-stream(?:;|$)/iu.test(response.headers.get("content-type") ?? "")
      ) {
        throw failResponse();
      }
      const body = observeBillingStream(response.body, {
        signal,
        maxTokens: payload.max_tokens,
        failResponse,
        settle: (cost) => {
          reserved -= DEEPSEEK_REQUEST_RESERVATION_MICROCNY;
          settled += cost;
          settledRequests += 1;
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}

function validPayload(value) {
  const text = (content) =>
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.every(
        (part) =>
          part?.type === "text" &&
          typeof part.text === "string" &&
          Object.keys(part).every((key) => key === "type" || key === "text"),
      ));
  const functionCall = (call) =>
    call?.type === "function" && typeof call.function?.name === "string";
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => REQUEST_FIELDS.has(key)) &&
    value.model === "deepseek-flash" &&
    value.stream === true &&
    (value.n === undefined || value.n === 1) &&
    Number.isSafeInteger(value.max_tokens) &&
    value.max_tokens > 0 &&
    value.max_tokens <= 1024 &&
    value.thinking?.type === "disabled" &&
    (value.reasoning_effort === undefined || value.reasoning_effort === "none") &&
    Array.isArray(value.messages) &&
    value.messages.length > 0 &&
    value.messages.every(
      (message) =>
        ["system", "user", "assistant", "tool"].includes(message?.role) &&
        (text(message.content) || (message.role === "assistant" && message.content === null)) &&
        Object.keys(message).every((key) =>
          ["role", "content", "name", "tool_call_id", "tool_calls", "reasoning_content"].includes(
            key,
          ),
        ) &&
        (message.reasoning_content === undefined || message.reasoning_content === "") &&
        (message.tool_calls === undefined ||
          (Array.isArray(message.tool_calls) && message.tool_calls.every(functionCall))),
    ) &&
    (value.tools === undefined || (Array.isArray(value.tools) && value.tools.every(functionCall)))
  );
}

function observeBillingStream(source, { signal, maxTokens, failResponse, settle }) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "";
  let data = [];
  let dataLength = 0;
  let skipLf = false;
  let finished = false;
  let usage;
  let done = false;
  let cancelled = false;
  let reader;
  const acceptEvent = () => {
    if (data.length === 0) return;
    const raw = data.join("\n");
    data = [];
    dataLength = 0;
    // [DONE] 是服务端终止合同；SDK 随后取消读取不撤销已经确认的完整账单。
    if (done) return;
    if (raw === "[DONE]") {
      if (!finished || !usage) throw failResponse();
      done = true;
      settle(usage.prompt_tokens * 2 + usage.completion_tokens * 8);
      return;
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw failResponse();
    }
    if (
      !event ||
      typeof event !== "object" ||
      event.error !== undefined ||
      usage ||
      (event.model !== undefined && event.model !== "deepseek-flash") ||
      !Array.isArray(event.choices) ||
      event.choices.length > 1
    )
      throw failResponse();
    const choice = event.choices[0];
    if (choice) {
      if (choice.index !== 0 || finished) throw failResponse();
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (!["stop", "tool_calls", "length"].includes(choice.finish_reason)) throw failResponse();
        finished = true;
      }
    }
    if (event.usage !== undefined && event.usage !== null) {
      const candidate = event.usage;
      if (
        !finished ||
        ![candidate.prompt_tokens, candidate.completion_tokens, candidate.total_tokens].every(
          (count) => Number.isSafeInteger(count) && count >= 0,
        ) ||
        candidate.prompt_tokens > CONTEXT_TOKENS ||
        candidate.completion_tokens > maxTokens ||
        candidate.total_tokens !== candidate.prompt_tokens + candidate.completion_tokens ||
        candidate.total_tokens > CONTEXT_TOKENS
      )
        throw failResponse();
      usage = candidate;
    }
  };
  const acceptLine = () => {
    if (line === "") acceptEvent();
    else if (line.startsWith("data:")) {
      const value = line.slice(line[5] === " " ? 6 : 5);
      dataLength += value.length + 1;
      if (dataLength > MAX_EVENT_CHARS) throw failResponse();
      data.push(value);
    } else if (line.startsWith("event:") && line.slice(6).trim() !== "message") {
      throw failResponse();
    }
    line = "";
  };
  const consume = (text) => {
    for (const char of text) {
      if (char === "\r") {
        acceptLine();
        skipLf = true;
      } else if (char === "\n") {
        if (!skipLf) acceptLine();
        skipLf = false;
      } else {
        skipLf = false;
        line += char;
        if (line.length + dataLength > MAX_EVENT_CHARS) throw failResponse();
      }
    }
  };
  const observer = new TransformStream({
    transform(chunk, controller) {
      try {
        // 解码窗口和未结束事件分别有界，不保留正文或另起后台读取。
        for (let offset = 0; offset < chunk.byteLength; offset += 4096) {
          consume(decoder.decode(chunk.subarray(offset, offset + 4096), { stream: true }));
        }
      } catch {
        throw failResponse();
      }
      controller.enqueue(chunk);
    },
    flush() {
      try {
        consume(decoder.decode());
      } catch {
        throw failResponse();
      }
      if (!done && !cancelled && !signal?.aborted) throw failResponse();
    },
  });
  return new ReadableStream(
    {
      async pull(controller) {
        reader ??= source.pipeThrough(observer).getReader();
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      },
      async cancel(reason) {
        cancelled = true;
        if (reader) await reader.cancel(reason);
        else await source.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

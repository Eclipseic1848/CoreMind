import { describe, expect, it, vi } from "vitest";
import {
  createDeepSeekCertificationGuard,
  DEEPSEEK_BILLING_CONTROL,
  DEEPSEEK_CERTIFICATION_OPTIONS,
  DEEPSEEK_REQUEST_RESERVATION_MICROCNY,
  toDeepSeekMicroCny,
} from "./deepseek-certification-budget.mjs";

const endpoint = "https://api.deepseek.com/chat/completions";
const reservation = 2.105344;
const encoder = new TextEncoder();

function request(overrides: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      stream: true,
      n: 1,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "合成请求" }],
      ...overrides,
    }),
  };
}

function finalFrame(overrides: Record<string, unknown> = {}) {
  return {
    model: "deepseek-flash",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    ...overrides,
  };
}

function event(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function sse(body = `${event(finalFrame())}data: [DONE]\n\n`) {
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

describe("DeepSeek 认证的人民币请求预留", () => {
  it("整数微元避免浮点少一，并对超过六位的小数向下取整", () => {
    expect(toDeepSeekMicroCny(1.000001)).toBe(1_000_001);
    expect(toDeepSeekMicroCny(1.0000019)).toBe(1_000_001);
    expect(toDeepSeekMicroCny(1e-6)).toBe(1);
    expect(toDeepSeekMicroCny(1e-7)).toBe(0);
    expect(toDeepSeekMicroCny(0)).toBe(0);
    for (const value of [-1, NaN, Infinity, "1", Number.MAX_VALUE]) {
      expect(() => toDeepSeekMicroCny(value)).toThrow("人民币金额");
    }
    expect(DEEPSEEK_REQUEST_RESERVATION_MICROCNY).toBe(1_048_576 * 2 + 1024 * 8);
    expect(DEEPSEEK_CERTIFICATION_OPTIONS).toEqual({ maxTokens: 1024, thinkingLevel: "off" });
  });

  it("预算不足时零发送；并发请求在原生 fetch 前共享同步预留", async () => {
    const fetchImpl = vi.fn(async () => sse());
    const insufficient = createDeepSeekCertificationGuard({
      maxCostCny: reservation - 0.000001,
      fetchImpl,
    });
    await expect(insufficient.fetch(endpoint, request())).rejects.toThrow("费用准入");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(insufficient.snapshot()).toMatchObject({ requests: 0, deniedRequests: 1 });
    expect(() => insufficient.assertHealthy()).toThrow("费用边界已失败");

    const concurrent = createDeepSeekCertificationGuard({ maxCostCny: reservation, fetchImpl });
    const results = await Promise.allSettled([
      concurrent.fetch(endpoint, request()),
      concurrent.fetch(endpoint, request()),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(concurrent.snapshot()).toMatchObject({
      requests: 1,
      retainedReservations: 1,
      deniedRequests: 1,
    });
    for (const result of results)
      if (result.status === "fulfilled") await result.value.body?.cancel();
  });

  it("完整用量按缓存未命中结算，释放差额后允许下一次请求", async () => {
    const fetchImpl = vi.fn(async () =>
      sse(
        event(
          finalFrame({
            usage: {
              prompt_tokens: 100,
              completion_tokens: 5,
              total_tokens: 105,
              prompt_cache_hit_tokens: 100,
            },
          }),
        ) + "data: [DONE]\n\n",
      ),
    );
    const guard = createDeepSeekCertificationGuard({
      maxCostCny: reservation + 0.00024,
      fetchImpl,
    });
    const first = await guard.fetch(endpoint, request());
    expect(guard.snapshot()).toMatchObject({ reservedCostCny: reservation, settledCostCny: 0 });
    await first.text();
    expect(guard.snapshot()).toMatchObject({ reservedCostCny: 0, settledCostCny: 0.00024 });
    await (await guard.fetch(endpoint, request())).text();
    expect(guard.snapshot()).toEqual({
      billingControl: DEEPSEEK_BILLING_CONTROL,
      currency: "CNY",
      maxCostCny: reservation + 0.00024,
      requests: 2,
      settledRequests: 2,
      retainedReservations: 0,
      settledCostCny: 0.00048,
      reservedCostCny: 0,
      exposureCny: 0.00048,
      deniedRequests: 0,
      invalidResponses: 0,
      authenticationRejections: 0,
    });
    guard.assertHealthy();
  });

  it("CRLF、跨字节中文与分离末块仍形成同一完整账单", async () => {
    const frames = [
      {
        model: "deepseek-flash",
        choices: [{ index: 0, delta: { content: "中文" }, finish_reason: null }],
      },
      finalFrame({ usage: null }),
      finalFrame({ choices: [] }),
    ];
    const body =
      frames
        .map(
          (frame) =>
            JSON.stringify(frame, null, 2)
              .split("\n")
              .map((line) => `data: ${line}`)
              .join("\r\n") + "\r\n\r\n",
        )
        .join("") + "data: [DONE]\r\n\r\n";
    const bytes = encoder.encode(body);
    let offset = 0;
    const source = new ReadableStream(
      {
        pull(controller) {
          if (offset === bytes.length) controller.close();
          else controller.enqueue(bytes.subarray(offset, ++offset));
        },
      },
      { highWaterMark: 0 },
    );
    const guard = createDeepSeekCertificationGuard({
      maxCostCny: reservation,
      fetchImpl: async () =>
        new Response(source, { headers: { "content-type": "text/event-stream" } }),
    });
    expect(await (await guard.fetch(endpoint, request())).text()).toBe(body);
    expect(guard.snapshot()).toMatchObject({
      settledRequests: 1,
      settledCostCny: 0.00024,
      invalidResponses: 0,
    });
  });

  it("源流跟随消费启动，没有后台读取或额外请求", async () => {
    let pulls = 0;
    const source = new ReadableStream(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(encoder.encode(`${event(finalFrame())}data: [DONE]\n\n`));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = vi.fn(
      async () => new Response(source, { headers: { "content-type": "text/event-stream" } }),
    );
    const guard = createDeepSeekCertificationGuard({ maxCostCny: reservation, fetchImpl });
    const response = await guard.fetch(endpoint, request());
    expect(pulls).toBe(0);
    expect(guard.snapshot().settledRequests).toBe(0);
    await response.text();
    expect(pulls).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("正常取消保留整笔预留，不把缺少末块误记为无效账单", async () => {
    let sent = false;
    const source = new ReadableStream(
      {
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(
              encoder.encode(
                event({
                  choices: [{ index: 0, delta: { content: "片段" }, finish_reason: null }],
                }),
              ),
            );
          }
        },
      },
      { highWaterMark: 0 },
    );
    const guard = createDeepSeekCertificationGuard({
      maxCostCny: reservation,
      fetchImpl: async () =>
        new Response(source, { headers: { "content-type": "text/event-stream" } }),
    });
    const reader = (await guard.fetch(endpoint, request())).body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(guard.snapshot()).toMatchObject({
      retainedReservations: 1,
      exposureCny: reservation,
      invalidResponses: 0,
    });
    guard.assertHealthy();
  });

  it("保留原 signal 与禁止重定向，网络中止不释放预留", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      expect(init?.redirect).toBe("error");
      controller.abort();
      throw new DOMException("合成取消", "AbortError");
    });
    const guard = createDeepSeekCertificationGuard({ maxCostCny: reservation, fetchImpl });
    await expect(
      guard.fetch(endpoint, { ...request(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(guard.snapshot()).toMatchObject({
      requests: 1,
      retainedReservations: 1,
      invalidResponses: 0,
    });
    guard.assertHealthy();
  });

  it.each([401, 503])("HTTP %i 保留预留，只有实际 401 才记录认证拒绝", async (status) => {
    const guard = createDeepSeekCertificationGuard({
      maxCostCny: reservation,
      fetchImpl: async () => new Response("合成错误", { status }),
    });
    expect((await guard.fetch(endpoint, request())).status).toBe(status);
    expect(guard.snapshot()).toMatchObject({
      requests: 1,
      retainedReservations: 1,
      exposureCny: reservation,
      authenticationRejections: status === 401 ? 1 : 0,
    });
    guard.assertHealthy();
  });

  it.each([
    { model: "deepseek-v4-pro" },
    { max_tokens: 1025 },
    { max_tokens: 0 },
    { max_completion_tokens: 1024 },
    { thinking: { type: "enabled" } },
    { n: 2 },
    {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "private" } }] }],
    },
    { tools: [{ type: "web_search" }] },
  ])("无界或非文本请求在发送前粘性拒绝：%j", async (override) => {
    const fetchImpl = vi.fn(async () => sse());
    const guard = createDeepSeekCertificationGuard({ maxCostCny: reservation, fetchImpl });
    await expect(guard.fetch(endpoint, request(override))).rejects.toThrow("费用准入");
    await expect(guard.fetch(endpoint, request())).rejects.toThrow("费用准入");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(guard.snapshot()).toMatchObject({ requests: 0, deniedRequests: 2 });
    expect(() => guard.assertHealthy()).toThrow("费用边界已失败");
  });

  it("不同端点与重定向均不能触发第二次发送", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 307, headers: { location: "https://example.invalid" } }),
    );
    const wrongEndpoint = createDeepSeekCertificationGuard({ maxCostCny: reservation, fetchImpl });
    await expect(wrongEndpoint.fetch(`${endpoint}?other=1`, request())).rejects.toThrow("费用准入");
    expect(fetchImpl).not.toHaveBeenCalled();
    const redirect = createDeepSeekCertificationGuard({ maxCostCny: reservation, fetchImpl });
    await expect(redirect.fetch(endpoint, request())).rejects.toThrow("完整账单");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(redirect.snapshot()).toMatchObject({ retainedReservations: 1, invalidResponses: 1 });
  });

  it.each([
    finalFrame({ usage: { prompt_tokens: 100, total_tokens: 105 } }),
    finalFrame({ usage: { prompt_tokens: -1, completion_tokens: 5, total_tokens: 4 } }),
    finalFrame({ usage: { prompt_tokens: 100, completion_tokens: 1025, total_tokens: 1125 } }),
    finalFrame({
      usage: { prompt_tokens: 1_048_577, completion_tokens: 0, total_tokens: 1_048_577 },
    }),
    finalFrame({ usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 1 } }),
    finalFrame({ model: "deepseek-v4-pro" }),
    finalFrame({ choices: [{ index: 1, delta: {}, finish_reason: "stop" }] }),
    finalFrame({ choices: [{ index: 0, delta: {}, finish_reason: "network_error" }] }),
  ])("伪造或不完整账单不能释放预留：%j", async (frame) => {
    const guard = createDeepSeekCertificationGuard({
      maxCostCny: reservation,
      fetchImpl: async () => sse(`${event(frame)}data: [DONE]\n\n`),
    });
    await expect((await guard.fetch(endpoint, request())).text()).rejects.toThrow("完整账单");
    expect(guard.snapshot()).toMatchObject({
      settledRequests: 0,
      retainedReservations: 1,
      invalidResponses: 1,
    });
    expect(() => guard.assertHealthy()).toThrow("费用边界已失败");
  });

  it.each([
    event(finalFrame()),
    `${event(finalFrame({ usage: null }))}data: [DONE]\n\n`,
    `${event(finalFrame())}${event(finalFrame())}data: [DONE]\n\n`,
    `data: ${"x".repeat(65_537)}\n\n`,
  ])("正常 EOF 缺末块、重复账单或超长事件均失败关闭", async (body) => {
    const guard = createDeepSeekCertificationGuard({
      maxCostCny: reservation,
      fetchImpl: async () => sse(body),
    });
    await expect((await guard.fetch(endpoint, request())).text()).rejects.toThrow("完整账单");
    expect(guard.snapshot()).toMatchObject({
      settledRequests: 0,
      retainedReservations: 1,
      invalidResponses: 1,
    });
  });
});

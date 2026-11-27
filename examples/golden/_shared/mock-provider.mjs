import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** 为黄金示例提供完全离线的 OpenAI-compatible SSE Provider。 */
export function createGoldenMockServer(profile) {
  return createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const messages = payload.messages ?? [];
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const userText = textOf(lastUser?.content);
      const systemText = messages
        .filter((message) => message.role === "system")
        .map((message) => textOf(message.content))
        .join("\n");
      const toolResult = [...messages].reverse().find((message) => message.role === "tool");

      if (profile === "order") {
        const structured = parseJson(userText);
        const orderId =
          typeof structured?.orderId === "string"
            ? structured.orderId
            : (userText.match(/(?:订单号|订单编号|orderId)\s*[:：=]\s*([^\s，。！？,;]+)/iu)?.[1] ??
              userText.match(
                /(?:[A-Za-z][A-Za-z\d]*|[\p{Script=Han}]+|\d+)(?:[-_][A-Za-z\d]+)+/u,
              )?.[0]);
        if (toolResult) {
          const result = textOf(toolResult.content);
          const order = parseJson(result);
          if (
            order &&
            typeof order.id === "string" &&
            typeof order.status === "string" &&
            Number.isFinite(order.amount)
          ) {
            const label = { paid: "已支付", pending: "待支付", refunded: "已退款" };
            const status = Object.hasOwn(label, order.status) ? label[order.status] : order.status;
            sendText(response, `订单 ${order.id} ${status}，金额 ${order.amount} 元。`);
          } else if (orderId && result === `订单 ${orderId} 不存在`) {
            sendText(response, `未找到订单 ${orderId}，请核对订单号。`);
          } else {
            sendText(response, "查询失败，当前无法确认订单状态。");
          }
        } else if (orderId) {
          sendTool(response, "lookup_order", { orderId }, "order-call");
        } else {
          sendText(response, "请提供订单号。");
        }
        return;
      }

      if (profile === "contract") {
        if (systemText.includes("条款提取")) {
          sendText(response, '{"clauses":["付款期限30天","责任上限缺失"]}');
        } else if (systemText.includes("风险审核")) {
          sendText(
            response,
            '{"risks":[{"level":"high","issue":"责任上限缺失","evidence":"未约定责任上限"}]}',
          );
        } else {
          sendText(
            response,
            '{"riskLevel":"high","summary":"责任上限缺失","requiresHumanReview":true}',
          );
        }
        return;
      }

      if (profile === "data") {
        if (toolResult) sendText(response, textOf(toolResult.content));
        else
          sendTool(
            response,
            "analyze_sales",
            { csv_path: "data/sales.csv", output_path: "artifacts/summary.json" },
            "data-call",
          );
        return;
      }

      if (profile === "research") {
        if (systemText.includes("证据审查")) {
          const evidence = parseJson(userText.split("EVIDENCE_COMPLETE\n").at(-1));
          if (!Array.isArray(evidence)) {
            sendText(response, "检索失败，未获得可核对的证据。");
          } else if (!evidence.length) {
            sendText(response, "未找到匹配证据，无法给出结论。");
          } else {
            const sources = evidence.map((item) => `[${item.id}] ${item.topic}：${item.finding}`);
            const pilot = evidence.some((item) => item.topic.includes("试点"));
            const conclusion = pilot
              ? "评估小规模试点条件，并由人工复核。"
              : "请按以下来源复核结论。";
            const confidence = evidence.length > 1 ? "中等，仍需人工复核" : "单一来源，待复核";
            sendText(
              response,
              `结论：${conclusion}\n${sources.join("\n")}\n置信度：${confidence}。`,
            );
          }
        } else if (toolResult) {
          sendText(response, `EVIDENCE_COMPLETE\n${textOf(toolResult.content)}`);
        } else {
          sendTool(
            response,
            "search_knowledge",
            { query: userText.replace(/^调查：/, "") },
            "research-call",
          );
        }
        return;
      }

      if (profile === "loop") {
        if (systemText.includes("独立验证")) {
          sendText(response, userText.includes("candidate-fixed") ? "PASS" : "FAIL");
        } else if (systemText.includes("有界修复")) {
          sendText(response, "candidate-fixed");
        } else {
          sendText(response, "candidate-needs-repair");
        }
        return;
      }

      sendText(response, `mock回复：${userText.slice(0, 50)}`);
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function sendText(response, text) {
  begin(response);
  response.write(
    `data: ${JSON.stringify({
      id: "golden-text",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "golden-text",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function sendTool(response, name, args, callId) {
  begin(response);
  response.write(
    `data: ${JSON.stringify({
      id: "golden-tool",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "golden-tool",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function begin(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("");
}

const directPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (directPath === import.meta.url) {
  const profile = process.argv[2] ?? "order";
  const port = Number(process.argv[3] ?? 8811);
  createGoldenMockServer(profile).listen(port, "127.0.0.1", () => {
    console.log(`黄金示例 mock Provider 已启动：${profile} http://127.0.0.1:${port}`);
  });
}

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
        if (toolResult) {
          sendText(
            response,
            userText.includes("A-999")
              ? "未找到订单 A-999，请核对订单号。"
              : "订单 A-100 已支付，金额 299 元。",
          );
        } else {
          const orderId = userText.match(/A-\d+/)?.[0] ?? "A-100";
          sendTool(response, "lookup_order", { orderId }, "order-call");
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
          sendText(
            response,
            "结论：应先做小规模试点。证据：S1 显示错误率下降，S2 提示仍需人工复核。置信度：中等。",
          );
        } else if (toolResult) {
          sendText(response, "EVIDENCE_COMPLETE：S1 与 S2 已交叉核对，并保留分歧。 ");
        } else {
          sendTool(response, "search_knowledge", { query: userText }, "research-call");
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

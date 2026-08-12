import { createServer } from "node:http";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) throw new Error("必须提供有效端口");

createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
    response.writeHead(404).end("not found");
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const messages = JSON.parse(body).messages ?? [];
    const toolResult = [...messages].reverse().find((message) => message.role === "tool");
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const prompt = extractText(lastUser?.content);

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (toolResult) {
      sendText(response, "工具完成");
      return;
    }
    if (prompt.includes("写入验收文件")) {
      sendToolCall(response);
      return;
    }
    if (prompt.includes("生成慢回复")) {
      const timer = setTimeout(() => sendText(response, "不应等到这段慢回复"), 15_000);
      response.on("close", () => clearTimeout(timer));
      return;
    }
    sendText(response, `mock回复：${prompt.slice(0, 30)}`);
  });
}).listen(port, "127.0.0.1");

function sendText(response, text) {
  response.write(
    `data: ${JSON.stringify({
      id: "text",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "text",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function sendToolCall(response) {
  response.write(
    `data: ${JSON.stringify({
      id: "tool",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-write-tty",
                type: "function",
                function: {
                  name: "write",
                  arguments: '{"path":"article.md","content":"真实 TTY 验收"}',
                },
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
      id: "tool",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text")
    .map((item) => item.text ?? "")
    .join("");
}

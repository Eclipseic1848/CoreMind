// 测试用 mock OpenAI 兼容 server（SSE 流式 chat/completions）
// 用法：node mock-openai-server.mjs <port>
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8787);

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let messages = [];
    try {
      messages = JSON.parse(body).messages ?? [];
    } catch {
      // 忽略解析错误
    }
    // 从最后一条用户消息取前 30 字符作为回复内容
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const replyText = `mock回复：${extractUserText(lastUser?.content).slice(0, 30)}`;

    // 提取 user message 文本（content 可能是字符串或 [{type:"text",text}] 数组）
    function extractUserText(content) {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
      }
      return "";
    }

    // SSE 流式响应
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk1 = {
      id: "mock-1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
    const chunk2 = {
      id: "mock-2",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: replyText }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
    const chunk3 = {
      id: "mock-3",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    res.write(`data: ${JSON.stringify(chunk3)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock OpenAI server 已启动：http://127.0.0.1:${port}`);
});

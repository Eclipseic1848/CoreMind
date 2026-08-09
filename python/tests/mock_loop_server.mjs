import { createServer } from "node:http";

const port = Number(process.argv[2]);

createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const payload = JSON.parse(body);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const rawInput = [...messages].reverse().find((message) => message?.role === "user")?.content;
    const input =
      typeof rawInput === "string"
        ? rawInput
        : Array.isArray(rawInput)
          ? rawInput.map((item) => (typeof item?.text === "string" ? item.text : "")).join("")
          : "";
    const text = input.includes("candidate-b")
      ? "PASS"
      : input.startsWith("验证")
        ? "FAIL"
        : input.startsWith("根据")
          ? "candidate-b"
          : "candidate-a";
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(
      `data: ${JSON.stringify({
        id: "loop",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: "loop",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1");

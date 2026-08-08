import { createServer } from "node:http";

const port = Number(process.argv[2]);
createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const messages = JSON.parse(body).messages ?? [];
    const toolResult = messages.find((message) => message.role === "tool");
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (toolResult) {
      response.write(
        `data: ${JSON.stringify({
          id: "final",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: toolResult.content },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "final",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
    } else {
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
                    id: "call-python",
                    type: "function",
                    function: {
                      name: "lookup_order",
                      arguments: '{"order_id":"A-1"}',
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
    }
    response.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1");

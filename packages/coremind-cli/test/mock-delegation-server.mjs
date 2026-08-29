// 测试用 Child Run 委派 server：父 Agent 委派，子 Agent 完成，父 Agent 再汇总。
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8801);

const server = createServer((request, response) => {
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
    const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
    const hasDelegationTool =
      payload.tools?.some((tool) => tool.function?.name === "delegate") ?? false;

    if (hasToolResult) {
      sendSse(response, textResponse("parent-final", "父任务完成"));
    } else if (hasDelegationTool) {
      sendSse(response, delegationResponse());
    } else {
      sendSse(response, textResponse("child-final", "子任务完成"));
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock Child Run server 已启动：http://127.0.0.1:${port}`);
});

function delegationResponse() {
  return [
    {
      id: "parent-tool",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-delegate",
                type: "function",
                function: {
                  name: "delegate",
                  arguments:
                    '{"target":"researcher","task":"研究已批准事实","references":[],"limits":{"tokens":800}}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id: "parent-tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function textResponse(id, content) {
  return [
    {
      id,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

function sendSse(response, chunks) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

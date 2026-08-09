import { createServer } from "node:http";

/** 为真实缺陷仓库提供确定性的 OpenAI-compatible 工具调用序列。 */
export function createCodingEvalMockServer(profile) {
  let nextStep = 0;
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
      JSON.parse(body);
      const step = codingSteps(profile)[nextStep++];
      if (!step) {
        const target = profile === "typescript" ? "src/discount.ts" : "src/pricing.py";
        sendText(
          response,
          `已完成 ${target} 的最小修改；目标测试和回归测试均已通过，Git diff 仅包含该文件。`,
        );
        return;
      }
      sendTool(response, step.name, step.args, `${profile}-call-${nextStep}`);
    });
  });
}

function codingSteps(profile) {
  if (profile === "typescript") {
    return [
      { name: "bash", args: { command: "node --test tests/discount.test.ts", timeout: 30 } },
      { name: "read", args: { path: "src/discount.ts" } },
      {
        name: "edit",
        args: {
          path: "src/discount.ts",
          edits: [
            {
              oldText: "  return price * discountRate;",
              newText: "  return price * (1 - discountRate);",
            },
          ],
        },
      },
      { name: "bash", args: { command: "node --test tests/discount.test.ts", timeout: 30 } },
      { name: "bash", args: { command: "node --test", timeout: 30 } },
      { name: "git_status", args: {} },
      { name: "git_diff", args: { path: "src/discount.ts" } },
    ];
  }
  if (profile === "python") {
    return [
      { name: "bash", args: { command: "python -m unittest tests.test_tax", timeout: 30 } },
      { name: "read", args: { path: "src/pricing.py" } },
      {
        name: "edit",
        args: {
          path: "src/pricing.py",
          edits: [
            {
              oldText: "    return subtotal * tax_rate",
              newText: "    return subtotal * (1 + tax_rate)",
            },
          ],
        },
      },
      { name: "bash", args: { command: "python -m unittest tests.test_tax", timeout: 30 } },
      {
        name: "bash",
        args: { command: "python -m unittest discover -s tests", timeout: 30 },
      },
      { name: "git_status", args: {} },
      { name: "git_diff", args: { path: "src/pricing.py" } },
    ];
  }
  throw new Error(`未知 Coding Eval profile：${profile}`);
}

function sendText(response, text) {
  begin(response);
  response.write(
    `data: ${JSON.stringify({
      id: "coding-eval-text",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "coding-eval-text",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function sendTool(response, name, args, callId) {
  begin(response);
  response.write(
    `data: ${JSON.stringify({
      id: "coding-eval-tool",
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
      id: "coding-eval-tool",
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

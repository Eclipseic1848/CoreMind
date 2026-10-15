import "../../../test/setup-env.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import type { CoreMindToolDefinition } from "./public-tool.js";
import { FileRunStore } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";

const privateMessage =
  "Authorization: Bearer terminal-auth-canary\nCookie: id=terminal-cookie-canary\nhttps://example.invalid/?token=terminal-query-canary&ordinary=keep\npassword=\x1b[31mterminal-color-canary\x1b[0m";
const canaries = /terminal-(?:auth|cookie|query|audit|arg|color)-canary/;

it("真实跨片段文本的 live 回调与原始 Facts 均不泄漏 Header 或 URL 凭据", async () => {
  await scenario(false, false, ({ result, events, records, requests }) => {
    expect(requests).toBe(1);
    const live = events
      .flatMap((event) => (event.type === "text_delta" ? [event.delta] : []))
      .join("");
    expect(live).not.toMatch(canaries);
    expect(live).toContain("https://example.invalid/");
    expect(canaries.test(JSON.stringify(records)), "原始 Facts").toBe(false);
    expect(canaries.test(JSON.stringify(result)), "RunResult").toBe(false);
    expect(result.outcome).toMatchObject({ status: "succeeded", finishReason: "completed" });
    const starts = events.filter((event) => event.type === "agent_start");
    const claims = events.filter((event) => event.type === "input_claimed");
    expect(starts).toHaveLength(1);
    expect(claims).toHaveLength(1);
    expect(events.indexOf(starts[0]!)).toBeLessThan(events.indexOf(claims[0]!));
  });
});

it("真实宿主工具保留原参数，typed 错误与审计值不能进入终态 Facts 或实时 UI", async () => {
  await scenario(true, false, ({ result, events, records, calls, requests }) => {
    expect(calls).toBe(1);
    expect(requests).toBe(1);
    expect(result.outcome).toMatchObject({
      status: "failed",
      finishReason: "agent_failed",
      error: { code: "agent_failed" },
    });
    expect(canaries.test(JSON.stringify({ result, events, records }))).toBe(false);
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      args: { token: "<已隐藏>", falseValue: false, zeroValue: 0, nil: null },
    });
  });
});

it("实时监听器修改工具事件不能改写 canonical Trace 或待提交事实", async () => {
  await scenario(true, true, ({ result, records }) => {
    expect(JSON.stringify({ trace: result.trace, records })).not.toContain(
      "forged-listener-content",
    );
    expect(result.trace.find(({ event }) => event.type === "tool_call")).toMatchObject({
      event: { args: { falseValue: false, zeroValue: 0, nil: null } },
    });
  });
});

async function scenario(
  tool: boolean,
  mutate: boolean,
  verify: (data: {
    result: Awaited<ReturnType<CoreMindRuntime["run"]>>;
    events: CoreMindEvent[];
    records: unknown[];
    requests: number;
    calls: number;
  }) => void,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-terminal-privacy-"));
  if (
    path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) ||
    !path.basename(directory).startsWith("coremind-terminal-privacy-")
  )
    throw new Error("验收临时目录越界，拒绝使用和清理");
  let requests = 0;
  let calls = 0;
  const events: CoreMindEvent[] = [];
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const deltas = tool
        ? [
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "terminal-probe-call",
                  type: "function",
                  function: {
                    name: "terminal_probe",
                    arguments: JSON.stringify({
                      token: "terminal-arg-canary",
                      falseValue: false,
                      zeroValue: 0,
                      nil: null,
                    }),
                  },
                },
              ],
            },
          ]
        : [
            "Authorization: Bea",
            "rer terminal-auth-",
            "canary\nCookie: id=terminal-cookie-",
            "canary\nhttps://example.invalid/?token=terminal-",
            "query-canary&ordinary=keep\npass\x1b[31m",
            "word\x1b[0m=\x1b[31mterminal-color-",
            "canary\x1b[0m",
          ].map((content) => ({ role: "assistant", content }));
      for (const delta of deltas) {
        response.write(
          `data: ${JSON.stringify({ id: "terminal-reply", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
      }
      response.write(
        `data: ${JSON.stringify({ id: "terminal-reply", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  let runtime: CoreMindRuntime | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const definition: CoreMindToolDefinition = {
      name: "terminal_probe",
      description: "终端隐私边界探针",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string" },
          falseValue: { type: "boolean" },
          zeroValue: { type: "number" },
          nil: { type: "null" },
        },
      },
      effect: { operations: ["read"], reversible: true },
      capability: {
        effect: "none",
        replay: "safe",
        concurrency: "parallel",
        checkpoint: "none",
        durability: "ordinary",
      },
      execute: async (args) => {
        calls += 1;
        try {
          expect(args).toEqual({
            token: "terminal-arg-canary",
            falseValue: false,
            zeroValue: 0,
            nil: null,
          });
        } catch (error) {
          failures.push(error);
        }
        throw new CoreMindError("agent_failed", privateMessage, {
          originalCode: "vendor?token=terminal-audit-canary",
        });
      },
    };
    const store = new FileRunStore(path.join(directory, "runs"));
    runtime = await CoreMindRuntime.create({
      config: {
        schemaVersion: 2,
        name: "终端隐私真实验收",
        provider: {
          id: "terminal-privacy-probe",
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          model: "probe",
          apiKeyEnv: "COREMIND_TEST_API_KEY",
        },
        agents: { main: { tools: [] } },
        permissions: { mode: "full", workspaceOnly: true, network: "deny" },
        runtime: {
          maxTurns: 3,
          maxToolCalls: 4,
          maxTokens: 8000,
          maxRetries: 0,
          maxToolFailures: 4,
          runTimeoutMs: 15000,
        },
      },
      configDir: directory,
      cwd: directory,
      initialPrompt: "执行合成终端隐私探针",
      runStore: store,
      toolDefinitions: tool ? [definition] : [],
      events: (event) => {
        events.push(structuredClone(event));
        if (mutate && event.type === "tool_call")
          event.args = { forged: "forged-listener-content" };
      },
      trace: (entry) => {
        if (mutate && entry.event.type === "tool_call")
          entry.event.args = { forged: "forged-listener-content" };
      },
    });
    const result = await runtime.run();
    expect(await runtime.waitForQuiescence()).toBe(true);
    expect(failures).toEqual([]);
    const records = (await readFile(result.runStateFile!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    verify({ result, events, records, requests, calls });
  } finally {
    await runtime?.waitForQuiescence();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

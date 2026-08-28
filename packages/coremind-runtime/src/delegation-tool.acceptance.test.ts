import "../../../test/setup-env.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectionEngine } from "./projection.js";
import { FileRunStore } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";

describe("Delegation Tool TypeScript happy path", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("由活动父 Run 调用 allowlist Agent，并持久化可投影的结构化结果", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-tool-"));
    temporaryDirectories.push(directory);
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string }>;
          tools?: Array<{ function?: { name?: string } }>;
        };
        requests.push(payload as Record<string, unknown>);
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "Delegation happy path",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKeyEnv: "COREMIND_TEST_API_KEY",
        },
        agents: {
          main: {
            systemPrompt: "你是父 Agent。",
            delegation: {
              targets: {
                researcher: {
                  budget: {
                    tokens: 1_000,
                    toolCalls: 2,
                    costUsd: 1,
                    wallTimeMs: 5_000,
                    steps: 2,
                    descendants: 0,
                  },
                },
              },
            },
          },
          researcher: { systemPrompt: "你是研究 Agent。" },
        },
        defaultAgent: "main",
        runtime: {
          maxSteps: 4,
          maxToolCalls: 4,
          maxTokens: 2_000,
          maxCostUsd: 2,
          runTimeoutMs: 10_000,
        },
        permissions: { mode: "full", workspaceOnly: true, network: "allow" },
      };
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "完成父任务",
        runStore: store,
      });

      const result = await runtime.run();
      const parentRecords = await store.read(result.runId);
      const projection = await ProjectionEngine.projectTree(store, result.runId);
      const delegation = parentRecords.find(
        (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
      );
      const joined = parentRecords.find(
        (record) => record.kind === "delegation" && record.payload.type === "parent_joined",
      );
      const childRunId = (delegation?.payload as { childRunId?: string } | undefined)?.childRunId;

      expect(result.outcome.status).toBe("succeeded");
      expect(result.transcript).toContain("父任务完成");
      expect(delegation?.payload).toMatchObject({
        type: "delegation_recorded",
        parentRunId: result.runId,
        agentName: "researcher",
        context: { references: ["fact:approved"] },
        requestedAllocation: { tokens: 800, toolCalls: 2 },
      });
      expect(joined?.payload).toMatchObject({
        type: "parent_joined",
        childRunId,
        result: { outcome: { status: "succeeded" } },
      });
      expect(result.childRuns?.nodes).toEqual([
        expect.objectContaining({
          childRunId,
          status: "joined",
          outcome: { status: "succeeded", finishReason: "completed" },
        }),
      ]);
      expect(projection.childRuns).toEqual(result.childRuns);
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[0]?.tools)).toContain('"name":"delegate"');
      expect(JSON.stringify(requests[1])).toContain("研究 Agent");
      expect(
        (requests[2]?.messages as Array<{ role?: string }> | undefined)?.some(
          (message) => message.role === "tool",
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("未配置 delegation 时不向模型暴露工具且不产生 Child Fact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-disabled-"));
    temporaryDirectories.push(directory);
    const requests: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body) as (typeof requests)[number]);
        sendSse(response, textResponse("disabled", "未委派"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: baseConfig((server.address() as AddressInfo).port, {
          main: { systemPrompt: "你是父 Agent。" },
        }),
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "直接完成",
        runStore: store,
      });
      const result = await runtime.run();

      expect(
        requests.flatMap((request) => request.tools ?? []).map((tool) => tool.function?.name),
      ).not.toContain("delegate");
      expect(requests).toHaveLength(1);
      expect((await store.read(result.runId)).some((record) => record.kind === "delegation")).toBe(
        false,
      );
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    ["非 allowlist Agent", '{"target":"auditor","task":"越权委派"}'],
    [
      "内联权限覆盖",
      '{"target":"researcher","task":"越权委派","provider":"other","permissions":{"mode":"full"}}',
    ],
    ["超过 Config 的预算", '{"target":"researcher","task":"越权委派","limits":{"tokens":1200}}'],
  ])("拒绝%s，并且不先写入 Child Fact", async (_label, argumentsJson) => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-reject-"));
    temporaryDirectories.push(directory);
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as { messages?: Array<{ role?: string }> };
        if (payload.messages?.some((message) => message.role === "tool")) {
          sendSse(response, textResponse("rejected-final", "拒绝后收口"));
          return;
        }
        sendSse(response, toolCallResponse(argumentsJson));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: baseConfig((server.address() as AddressInfo).port, {
          main: {
            systemPrompt: "你是父 Agent。",
            delegation: {
              targets: {
                researcher: {
                  budget: {
                    tokens: 1_000,
                    toolCalls: 2,
                    costUsd: 1,
                    wallTimeMs: 5_000,
                    steps: 2,
                    descendants: 0,
                  },
                },
              },
            },
          },
          researcher: { systemPrompt: "你是研究 Agent。" },
          auditor: { systemPrompt: "你是未授权审计 Agent。" },
        }),
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "尝试委派",
        runStore: store,
      });
      const result = await runtime.run();
      const records = await store.read(result.runId);

      expect(records.some((record) => record.kind === "delegation")).toBe(false);
      expect(result.outcome.status).toBe("failed");
      expect(result.outcome.error?.code).toBe("child_run_policy_escalation");
    } finally {
      await closeServer(server);
    }
  });

  it("目标 Agent 的工具超出父 Agent authority 时在 Child Fact 前拒绝", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-tools-"));
    temporaryDirectories.push(directory);
    const server = createServer((_request, response) => {
      sendSse(response, toolCallResponse('{"target":"researcher","task":"尝试扩大工具权限"}'));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: baseConfig((server.address() as AddressInfo).port, {
          main: {
            systemPrompt: "你是父 Agent。",
            delegation: {
              targets: {
                researcher: {
                  budget: {
                    tokens: 1_000,
                    toolCalls: 2,
                    costUsd: 1,
                    wallTimeMs: 5_000,
                    steps: 2,
                    descendants: 0,
                  },
                },
              },
            },
          },
          researcher: { systemPrompt: "你是研究 Agent。", tools: [{ id: "read" }] },
        }),
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "尝试委派",
        runStore: store,
      });
      const result = await runtime.run();
      const records = await store.read(result.runId);

      expect(result.outcome).toMatchObject({
        status: "failed",
        error: { code: "child_run_policy_escalation" },
      });
      expect(records.some((record) => record.kind === "delegation")).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("父 Run 未活动时拒绝独立委派入口", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-inactive-"));
    temporaryDirectories.push(directory);
    const runtime = await CoreMindRuntime.create({
      config: baseConfig(1, {
        main: { systemPrompt: "你是父 Agent。" },
      }),
      configDir: directory,
      cwd: directory,
      env: { COREMIND_TEST_API_KEY: "test-key" },
    });

    await expect(runtime.delegateChildRun({} as never)).rejects.toMatchObject({
      code: "child_run_unavailable",
    });
  });
});

function baseConfig(port: number, agents: CoreMindConfig["agents"]): CoreMindConfig {
  return {
    schemaVersion: 2,
    name: "Delegation acceptance",
    provider: {
      id: "probe",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "probe-model",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    agents,
    defaultAgent: "main",
    runtime: {
      maxSteps: 4,
      maxToolCalls: 4,
      maxTokens: 2_000,
      maxCostUsd: 2,
      runTimeoutMs: 10_000,
    },
    permissions: { mode: "full", workspaceOnly: true, network: "allow" },
  };
}

function delegationResponse(): unknown[] {
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
                    '{"target":"researcher","task":"研究已批准事实","references":["fact:approved"],"limits":{"tokens":800}}',
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

function toolCallResponse(argumentsJson: string): unknown[] {
  return [
    {
      id: "invalid-tool",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-invalid-delegate",
                type: "function",
                function: { name: "delegate", arguments: argumentsJson },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id: "invalid-tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function textResponse(id: string, text: string): unknown[] {
  return [
    {
      id,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

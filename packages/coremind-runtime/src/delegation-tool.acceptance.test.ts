import "../../../test/setup-env.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { afterEach, describe, expect, it } from "vitest";
import { ChatSession } from "./chat-session.js";
import { ProjectionEngine } from "./projection.js";
import { FileRunStore } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";
import type { ToolApprovalRequest } from "./tool-policy.js";
import type { CoreMindTraceEvent } from "./trace.js";

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
    let markChildRequested = () => {};
    const childRequested = new Promise<void>((resolve) => {
      markChildRequested = resolve;
    });
    let releaseChildResponse = () => {};
    const childResponseReleased = new Promise<void>((resolve) => {
      releaseChildResponse = resolve;
    });
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string }>;
          model?: string;
          temperature?: number;
          max_completion_tokens?: number;
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
          markChildRequested();
          void childResponseReleased.then(() => {
            sendSse(response, textResponse("child-final", "子任务完成"));
          });
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
              budget: {
                tokens: 1_000,
                toolCalls: 2,
                costUsd: 1,
                wallTimeMs: 5_000,
                steps: 2,
                descendants: 1,
              },
              limits: { maxDepth: 2, maxActiveChildren: 1, maxDescendants: 1 },
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

      const chat = new ChatSession(runtime, "main");
      const resultPromise = chat.chat("完成父任务");
      const startup = await within(
        Promise.race([
          childRequested.then(() => ({ state: "child_requested" as const })),
          resultPromise.then((result) => ({ state: "parent_finished" as const, result })),
        ]),
        "Child 请求未到达且父 Run 未结束",
      );
      if (startup.state === "parent_finished") {
        throw new Error(`父 Run 提前结束：${JSON.stringify(startup.result.run.outcome)}`);
      }
      const activeProjection = await within(
        chat.inspectCurrentRunProjection(),
        "活动 Projection 查询阻塞",
      );
      expect(activeProjection?.childRuns).toMatchObject({
        activeDescendants: 1,
        unhandledDescendants: 1,
        quiescent: false,
        nodes: [expect.objectContaining({ agentName: "researcher", status: "running" })],
      });
      releaseChildResponse();
      const { run: result } = await within(resultPromise, "Child 响应后父 Run 未收敛");
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
        inheritedPolicy: {
          maxDepth: 1,
          maxActiveChildren: 0,
          maxDescendants: 0,
        },
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
      expect(JSON.stringify(requests[0]?.tools)).toContain('"maxDepth"');
      expect(JSON.stringify(requests[0]?.tools)).toContain('"maxActiveChildren"');
      expect(JSON.stringify(requests[1])).toContain("研究 Agent");
      expect(
        (requests[2]?.messages as Array<{ role?: string }> | undefined)?.some(
          (message) => message.role === "tool",
        ),
      ).toBe(true);
    } finally {
      releaseChildResponse();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("正式产品路径保留命名 Agent 的后代委派并在任意深度维持收紧策略", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-tree-"));
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
        const serialized = JSON.stringify(payload);
        const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
        const hasDelegationTool =
          payload.tools?.some((tool) => tool.function?.name === "delegate") ?? false;
        if (hasToolResult) {
          sendSse(
            response,
            serialized.includes("你是研究 Agent")
              ? textResponse("researcher-final", "研究子任务完成")
              : textResponse("parent-final", "父任务完成"),
          );
        } else if (hasDelegationTool && serialized.includes("你是父 Agent")) {
          sendSse(
            response,
            delegationResponseTo("researcher", "call-researcher", [
              "fact:approved-context",
              "artifact:approved-context",
            ]),
          );
        } else if (hasDelegationTool && serialized.includes("你是研究 Agent")) {
          sendSse(
            response,
            delegationResponseTo("reviewer", "call-reviewer", [
              "fact:approved-context",
              "artifact:approved-context",
            ]),
          );
        } else {
          sendSse(response, textResponse("reviewer-final", "审查子任务完成"));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "Delegation tree",
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
              budget: {
                tokens: 2_000,
                toolCalls: 4,
                costUsd: 2,
                wallTimeMs: 45_000,
                steps: 4,
                descendants: 2,
              },
              limits: { maxDepth: 2, maxActiveChildren: 1, maxDescendants: 2 },
              targets: {
                researcher: {
                  budget: {
                    tokens: 1_000,
                    toolCalls: 2,
                    costUsd: 1,
                    wallTimeMs: 30_000,
                    steps: 2,
                    descendants: 1,
                  },
                },
              },
            },
          },
          researcher: {
            systemPrompt: "你是研究 Agent。",
            model: "researcher-model",
            options: { temperature: 0.2, maxTokens: 900 },
            delegation: {
              budget: {
                tokens: 400,
                toolCalls: 1,
                costUsd: 0.4,
                wallTimeMs: 20_000,
                steps: 1,
                descendants: 1,
              },
              limits: { maxDepth: 2, maxActiveChildren: 1, maxDescendants: 1 },
              targets: {
                reviewer: {
                  budget: {
                    tokens: 400,
                    toolCalls: 1,
                    costUsd: 0.4,
                    wallTimeMs: 10_000,
                    steps: 1,
                    descendants: 0,
                  },
                },
              },
            },
          },
          reviewer: {
            systemPrompt: "你是审查 Agent。",
            model: "reviewer-model",
            options: { temperature: 0.1, maxTokens: 300 },
          },
        },
        defaultAgent: "main",
        runtime: {
          maxSteps: 8,
          maxToolCalls: 8,
          maxTokens: 4_000,
          maxCostUsd: 4,
          runTimeoutMs: 60_000,
        },
        permissions: { mode: "full", workspaceOnly: true, network: "allow" },
      };
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "完成父任务；PARENT_PRIVATE_MARKER；UNREFERENCED_FILE_MARKER",
        runStore: store,
      });

      const result = await runtime.run();
      const tree = await ProjectionEngine.projectTree(store, result.runId);
      const researcherNode = tree.childRuns?.nodes.find((node) => node.agentName === "researcher");
      const rootDelegation = (await store.read(result.runId)).find(
        (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
      );
      const nestedDelegation = researcherNode
        ? (await store.read(researcherNode.childRunId)).find(
            (record) =>
              record.kind === "delegation" && record.payload.type === "delegation_recorded",
          )
        : undefined;

      expect(result.outcome.status).toBe("succeeded");
      expect(tree.childRuns?.nodes).toEqual([
        expect.objectContaining({
          parentRunId: result.runId,
          agentName: "researcher",
          budget: expect.objectContaining({ tokens: 1_000, descendants: 1 }),
          outcome: { status: "succeeded", finishReason: "completed" },
        }),
        expect.objectContaining({
          agentName: "reviewer",
          budget: expect.objectContaining({ tokens: 400, descendants: 0 }),
          outcome: { status: "succeeded", finishReason: "completed" },
        }),
      ]);
      expect(rootDelegation?.payload).toMatchObject({
        budgetScope: "main",
        model: {
          providerId: "probe",
          model: "researcher-model",
          options: { temperature: 0.2, maxTokens: 900 },
        },
        inheritedPolicy: { depth: 1, maxDepth: 2, maxActiveChildren: 1, maxDescendants: 1 },
      });
      expect(nestedDelegation?.payload).toMatchObject({
        budgetScope: "researcher",
        model: {
          providerId: "probe",
          model: "reviewer-model",
          options: { temperature: 0.1, maxTokens: 300 },
        },
        inheritedPolicy: { depth: 2, maxDepth: 2, maxActiveChildren: 1, maxDescendants: 0 },
      });
      expect(requests).toHaveLength(5);
      const researcherRequests = requests.filter((request) =>
        JSON.stringify(request).includes("你是研究 Agent"),
      );
      const reviewerRequests = requests.filter((request) =>
        JSON.stringify(request).includes("你是审查 Agent"),
      );
      const parentJoinRequest = requests.find(
        (request) =>
          JSON.stringify(request).includes("你是父 Agent") &&
          (request.messages as Array<{ role?: string }> | undefined)?.some(
            (message) => message.role === "tool",
          ),
      );
      const parentToolMessage = (
        parentJoinRequest?.messages as Array<{ role?: string; content?: string }> | undefined
      )?.find((message) => message.role === "tool");
      const parentToolResult = JSON.parse(parentToolMessage?.content ?? "null") as unknown;
      expect(researcherRequests).not.toHaveLength(0);
      const researcherInitialRequest = researcherRequests.find(
        (request) =>
          !(request.messages as Array<{ role?: string }> | undefined)?.some(
            (message) => message.role === "tool",
          ),
      );
      expect(JSON.stringify(researcherInitialRequest)).toContain("fact:approved-context");
      expect(JSON.stringify(researcherInitialRequest)).toContain("artifact:approved-context");
      expect(JSON.stringify(researcherInitialRequest)).not.toContain("PARENT_PRIVATE_MARKER");
      expect(JSON.stringify(researcherInitialRequest)).not.toContain("UNREFERENCED_FILE_MARKER");
      expect(JSON.stringify(researcherInitialRequest)).not.toContain("test-key");
      expect(parentToolResult).toMatchObject({
        childRunId: expect.any(String),
        result: {
          outcome: { status: "succeeded", finishReason: "completed" },
          evidence: expect.any(Array),
          artifacts: expect.any(Array),
          workspaceChanges: expect.any(Array),
          unresolvedRisks: expect.any(Array),
        },
      });
      expect(JSON.stringify(parentJoinRequest)).not.toContain("审查子任务完成");
      expect(JSON.stringify(parentJoinRequest)).not.toContain("研究子任务完成");
      expect(JSON.stringify(parentJoinRequest)).not.toContain("你是研究 Agent");
      expect(JSON.stringify(parentJoinRequest)).not.toContain("你是审查 Agent");
      expect(researcherRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            model: "researcher-model",
            temperature: 0.2,
            max_completion_tokens: 900,
          }),
        ]),
      );
      expect(reviewerRequests).not.toHaveLength(0);
      expect(reviewerRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            model: "reviewer-model",
            temperature: 0.1,
            max_completion_tokens: 300,
          }),
        ]),
      );
    } finally {
      await closeServer(server);
    }
  }, 45_000);

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

  it("Delegation Approval 与 Child Tool Effect 分别审批并写入各自 Run Facts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-approval-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "notes.txt"), "独立审批证据", "utf8");
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string }>;
        };
        const serializedMessages = JSON.stringify(payload.messages ?? []);
        const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
        const child = serializedMessages.includes("研究 Agent");
        if (hasToolResult) {
          sendSse(
            response,
            textResponse(
              child ? "child-approved" : "parent-approved",
              child ? "子任务完成" : "父任务完成",
            ),
          );
        } else if (child) {
          sendSse(response, readToolResponse());
        } else {
          sendSse(response, delegationResponse());
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const approvals: ToolApprovalRequest[] = [];
      const store = new FileRunStore(path.join(directory, "runs"));
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...baseConfig(port, {
            main: {
              systemPrompt: "你是父 Agent。",
              tools: [{ id: "read" }],
              delegation: {
                budget: parentDelegationBudget(),
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
          permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
        },
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "完成父任务",
        runStore: store,
        approveTool: async (request) => {
          approvals.push(request);
          return "allow";
        },
      });

      const result = await runtime.run();
      const childRunId = result.childRuns?.nodes[0]?.childRunId;
      const parentRecords = await store.read(result.runId);
      const delegation = parentRecords.find(
        (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
      );
      const parentApprovals = result.trace
        .map((entry) => entry.event)
        .filter((event) => event.type === "approval_required");
      const parentResolvedApprovals = result.trace
        .map((entry) => entry.event)
        .filter((event) => event.type === "approval_resolved");
      const childApprovals = childRunId
        ? (await store.read(childRunId))
            .flatMap((record) =>
              record.kind === "event" ? [(record.payload as CoreMindTraceEvent).event] : [],
            )
            .filter(
              (
                event,
              ): event is Extract<
                (typeof result.trace)[number]["event"],
                { type: "approval_required" }
              > =>
                typeof event === "object" &&
                event !== null &&
                "type" in event &&
                event.type === "approval_required",
            )
        : [];

      expect(result.outcome.status).toBe("succeeded");
      expect(approvals.map((request) => request.tool)).toEqual(["delegate", "read"]);
      expect(approvals[0]).toMatchObject({
        tool: "delegate",
        args: {
          target: "researcher",
          task: "研究已批准事实",
          references: ["fact:approved"],
          limits: {
            tokens: 800,
            toolCalls: 2,
            costUsd: 1,
            wallTimeMs: 5_000,
            steps: 2,
            descendants: 0,
          },
        },
        argumentsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        delegationInputFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
      expect(approvals[0]?.delegationInputFingerprint).toBe(
        (delegation?.payload as { inputFingerprint?: string } | undefined)?.inputFingerprint,
      );
      expect(parentApprovals).toEqual([
        expect.objectContaining({
          tool: "delegate",
          argumentsFingerprint: approvals[0]?.argumentsFingerprint,
          delegationInputFingerprint: approvals[0]?.delegationInputFingerprint,
        }),
      ]);
      expect(parentResolvedApprovals).toEqual([
        expect.objectContaining({
          decision: "allow",
          argumentsFingerprint: approvals[0]?.argumentsFingerprint,
          delegationInputFingerprint: approvals[0]?.delegationInputFingerprint,
        }),
      ]);
      expect(childApprovals).toEqual([
        expect.objectContaining({
          tool: "read",
          argumentsFingerprint: approvals[1]?.argumentsFingerprint,
        }),
      ]);
      expect(approvals[1]?.argumentsFingerprint).not.toBe(approvals[0]?.argumentsFingerprint);
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    ["未预批准", false, 1],
    ["显式预批准", true, 0],
  ] as const)(
    "assisted 模式%s Target 的委派审批次数正确",
    async (_label, preapproved, expected) => {
      const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-assisted-"));
      temporaryDirectories.push(directory);
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
          const hasToolResult =
            payload.messages?.some((message) => message.role === "tool") ?? false;
          const hasDelegationTool =
            payload.tools?.some((tool) => tool.function?.name === "delegate") ?? false;
          if (hasToolResult) sendSse(response, textResponse("assisted-parent", "父任务完成"));
          else if (hasDelegationTool) sendSse(response, delegationResponse());
          else sendSse(response, textResponse("assisted-child", "子任务完成"));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

      try {
        const approvals: ToolApprovalRequest[] = [];
        const port = (server.address() as AddressInfo).port;
        const runtime = await CoreMindRuntime.create({
          config: {
            ...baseConfig(port, {
              main: {
                systemPrompt: "你是父 Agent。",
                delegation: {
                  budget: parentDelegationBudget(),
                  targets: {
                    researcher: {
                      ...(preapproved ? { preapproved: true } : {}),
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
            }),
            permissions: { mode: "assisted", workspaceOnly: true, network: "deny" },
          },
          configDir: directory,
          cwd: directory,
          env: { COREMIND_TEST_API_KEY: "test-key" },
          initialPrompt: "完成父任务",
          runStore: new FileRunStore(path.join(directory, "runs")),
          approveTool: async (request) => {
            approvals.push(request);
            return "allow";
          },
        });

        const result = await runtime.run();
        expect(result.outcome.status).toBe("succeeded");
        expect(approvals.filter((request) => request.tool === "delegate")).toHaveLength(expected);
      } finally {
        await closeServer(server);
      }
    },
  );

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
              budget: parentDelegationBudget(),
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
              budget: parentDelegationBudget(),
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

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

function parentDelegationBudget() {
  return {
    tokens: 1_000,
    toolCalls: 2,
    costUsd: 1,
    wallTimeMs: 5_000,
    steps: 2,
    descendants: 1,
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
                    '{"target":"researcher","task":"研究已批准事实","references":["fact:approved"],"limits":{"tokens":800,"maxDepth":1,"maxActiveChildren":0}}',
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

function delegationResponseTo(
  target: string,
  callId: string,
  references: string[] = [],
): unknown[] {
  return toolCallResponse(
    JSON.stringify({ target, task: `委派给 ${target}`, references, limits: {} }),
  ).map((chunk) => {
    const cloned = structuredClone(chunk) as {
      choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string }> } }>;
    };
    const toolCall = cloned.choices?.[0]?.delta?.tool_calls?.[0];
    if (toolCall) toolCall.id = callId;
    return cloned;
  });
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

function readToolResponse(): unknown[] {
  return [
    {
      id: "child-read",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-child-read",
                type: "function",
                function: { name: "read", arguments: '{"path":"notes.txt"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id: "child-read", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
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

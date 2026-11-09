import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAndValidate } from "coremind-config";
import { expect, it, vi } from "vitest";
import { FileRunStore } from "../packages/coremind-runtime/src/run-state.js";
import { CoreMindRuntime } from "../packages/coremind-runtime/src/runtime.js";
import {
  createDeepSeekCertificationGuard,
  DEEPSEEK_CERTIFICATION_OPTIONS,
} from "./deepseek-certification-budget.mjs";

it("真实 Runtime 的 assistant、父模型和 Child 均经过同一费用准入并关闭思考", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-deepseek-cert-test-"));
  const payloads: Array<Record<string, any>> = [];
  const guard = createDeepSeekCertificationGuard({
    maxCostCny: 3,
    fetchImpl: async (request: Request) => {
      const payload = JSON.parse(await request.text());
      payloads.push(payload);
      const delegate = payload.tools?.some((tool: any) => tool.function.name === "delegate");
      const hasResult = payload.messages.some((message: any) => message.role === "tool");
      const delta =
        delegate && !hasResult
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "cert-child",
                  type: "function",
                  function: {
                    name: "delegate",
                    arguments: JSON.stringify({
                      target: "worker",
                      task: "合成任务",
                      references: [],
                      limits: {},
                    }),
                  },
                },
              ],
            }
          : { content: "完成" };
      const events = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [
            { index: 0, delta: {}, finish_reason: delegate && !hasResult ? "tool_calls" : "stop" },
          ],
        },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } },
      ];
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
  vi.stubGlobal("fetch", guard.fetch);
  try {
    const { config } = parseAndValidate({
      schemaVersion: 2,
      name: "DeepSeek 认证线路回归",
      provider: { id: "deepseek", model: "deepseek-flash", apiKeyEnv: "DEEPSEEK_API_KEY" },
      agents: {
        assistant: { systemPrompt: "合成助手", options: DEEPSEEK_CERTIFICATION_OPTIONS },
        parent: {
          systemPrompt: "合成父任务",
          options: DEEPSEEK_CERTIFICATION_OPTIONS,
          delegation: {
            budget: {
              tokens: 50_000,
              toolCalls: 2,
              costUsd: 0.5,
              wallTimeMs: 10_000,
              steps: 6,
              descendants: 1,
            },
            limits: { maxDepth: 1, maxActiveChildren: 1, maxDescendants: 1 },
            targets: {
              worker: {
                budget: {
                  tokens: 30_000,
                  toolCalls: 0,
                  costUsd: 0.25,
                  wallTimeMs: 5_000,
                  steps: 4,
                  descendants: 0,
                },
              },
            },
          },
        },
        worker: { systemPrompt: "合成子任务", options: DEEPSEEK_CERTIFICATION_OPTIONS },
      },
      defaultAgent: "parent",
      permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
      runtime: {
        maxTurns: 6,
        maxSteps: 8,
        maxToolCalls: 4,
        maxRetries: 0,
        maxTokens: 80_000,
        maxCostUsd: 0.5,
        runTimeoutMs: 10_000,
      },
    });
    const runtime = await CoreMindRuntime.create({
      config,
      configDir: directory,
      cwd: directory,
      env: { DEEPSEEK_API_KEY: "test-only" },
      initialPrompt: "执行合成任务",
      runStore: new FileRunStore(path.join(directory, "runs")),
      approveTool: async () => "allow",
    });
    const result = await runtime.run();
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("succeeded");
    expect(result.childRuns?.nodes).toHaveLength(1);
    expect(result.childRuns?.nodes[0].outcome?.status).toBe("succeeded");
    const assistant = await CoreMindRuntime.create({
      config: { ...config, defaultAgent: "assistant" },
      configDir: directory,
      cwd: directory,
      env: { DEEPSEEK_API_KEY: "test-only" },
      initialPrompt: "回复完成",
    });
    expect((await assistant.run()).outcome.status).toBe("succeeded");
    expect(payloads).toHaveLength(4);
    for (const payload of payloads) {
      expect(payload).toMatchObject({
        model: "deepseek-flash",
        max_tokens: 1024,
        thinking: { type: "disabled" },
      });
      expect(payload).not.toHaveProperty("max_completion_tokens");
    }
    expect(guard.snapshot()).toMatchObject({
      requests: 4,
      settledRequests: 4,
      retainedReservations: 0,
      deniedRequests: 0,
      invalidResponses: 0,
      exposureCny: 0.00096,
    });
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

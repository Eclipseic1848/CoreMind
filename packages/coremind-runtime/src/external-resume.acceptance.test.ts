import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import type { ResolvedToolCapability } from "coremind-tools";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEffectReceiptBinding,
  fingerprintEffectReceiptValue,
} from "./effect-receipt-binding.js";
import type { CoreMindEvent } from "./events.js";
import type { CoreMindToolDefinition } from "./public-tool.js";
import {
  FileRunStore,
  fingerprintRunConfig,
  prepareRunResume,
  type RunStateRecord,
} from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("External Observable Read 恢复处置", () => {
  it("持久化结果与参数指纹匹配时复用步骤，Provider 与外部服务均不联网", async () => {
    let providerRequests = 0;
    let externalRequests = 0;
    const provider = createServer((_request, response) => {
      providerRequests += 1;
      response.writeHead(500).end();
    });
    const external = createServer((_request, response) => {
      externalRequests += 1;
      response.writeHead(200).end("unexpected");
    });
    await Promise.all([listen(provider), listen(external)]);
    const root = temporaryRoot("coremind-external-resume-reuse-");
    const config = resumeConfig(portOf(provider));
    const store = new FileRunStore(path.join(root, "runs"));
    const args = { url: `http://127.0.0.1:${portOf(external)}/persisted` };
    const runId = "external-result-reuse";
    await appendRecords(
      store,
      resumeRecords({
        runId,
        config,
        args,
        capability: externalCapability("idempotent"),
        receiptStatuses: ["started", "committed"],
        completedText: "已持久化结果",
      }),
    );

    try {
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: root,
        cwd: root,
        initialPrompt: "继续",
        resumeRunId: runId,
        runStore: store,
        toolDefinitions: [externalTool(() => undefined)],
      });
      const result = await runtime.run();

      expect(result.outcome.status).toBe("succeeded");
      expect(result.outputs.get("external-result")?.text).toBe("已持久化结果");
      expect(providerRequests).toBe(0);
      expect(externalRequests).toBe(0);
    } finally {
      await Promise.all([close(provider), close(external)]);
    }
  });

  it("已绑定的幂等调用以新 Call 创建 attempt，旧 Receipt 保持不可变", async () => {
    let externalRequests = 0;
    const external = createServer((_request, response) => {
      externalRequests += 1;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
    });
    await listen(external);
    const args = { url: `http://127.0.0.1:${portOf(external)}/idempotent` };
    const provider = createToolCallingProvider("external_probe", args);
    await listen(provider);
    const root = temporaryRoot("coremind-external-resume-idempotent-");
    const config = resumeConfig(portOf(provider));
    const store = new FileRunStore(path.join(root, "runs"));
    const runId = "external-idempotent-retry";
    const oldReceiptId = `${runId}:external-step:old-external-call`;
    await appendRecords(
      store,
      resumeRecords({
        runId,
        config,
        args,
        capability: externalCapability("idempotent"),
        receiptStatuses: ["started", "unknown"],
      }),
    );

    try {
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: root,
        cwd: root,
        initialPrompt: "继续",
        resumeRunId: runId,
        runStore: store,
        approveTool: async () => "allow",
        toolDefinitions: [
          externalTool(async (url) => {
            const response = await fetch(url);
            await response.text();
          }),
        ],
      });
      const result = await runtime.run();
      const events = (await store.read(runId)).flatMap((record) => eventFrom(record));
      const attempts = events.filter(
        (event): event is Record<string, unknown> & { type: "tool_attempt" } =>
          event.type === "tool_attempt",
      );
      const oldStatuses = events.flatMap((event) =>
        event.type === "effect_receipt" && event.idempotencyKey === oldReceiptId
          ? [event.status]
          : [],
      );
      const newReceiptIds = events.flatMap((event) =>
        event.type === "effect_receipt" && event.idempotencyKey !== oldReceiptId
          ? [event.idempotencyKey]
          : [],
      );

      expect(result.outcome.status).toBe("succeeded");
      expect(externalRequests).toBe(1);
      expect(attempts).toEqual([
        expect.objectContaining({
          previousReceiptId: oldReceiptId,
          attempt: 2,
          callId: "new-external-call",
          tool: "external_probe",
        }),
      ]);
      expect(oldStatuses).toEqual(["started", "unknown"]);
      expect(new Set(newReceiptIds)).toEqual(new Set([`${runId}:external-step:new-external-call`]));
    } finally {
      await Promise.all([close(provider), close(external)]);
    }
  });

  it("恢复时 Capability 漂移会在 Provider 与外部联网前失败关闭", async () => {
    let providerRequests = 0;
    let externalRequests = 0;
    const provider = createServer((_request, response) => {
      providerRequests += 1;
      response.writeHead(500).end();
    });
    const external = createServer((_request, response) => {
      externalRequests += 1;
      response.writeHead(200).end("unexpected");
    });
    await Promise.all([listen(provider), listen(external)]);
    const root = temporaryRoot("coremind-external-resume-capability-drift-");
    const config = resumeConfig(portOf(provider));
    const store = new FileRunStore(path.join(root, "runs"));
    const runId = "external-capability-drift";
    await appendRecords(
      store,
      resumeRecords({
        runId,
        config,
        args: { url: `http://127.0.0.1:${portOf(external)}/drift` },
        capability: externalCapability("idempotent"),
        receiptStatuses: ["started", "unknown"],
      }),
    );

    try {
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: root,
        cwd: root,
        initialPrompt: "继续",
        resumeRunId: runId,
        runStore: store,
        toolDefinitions: [externalTool(() => undefined, "unknown")],
      });

      await expect(runtime.run()).rejects.toMatchObject({ code: "tool_capability_conflict" });
      expect(providerRequests).toBe(0);
      expect(externalRequests).toBe(0);
    } finally {
      await Promise.all([close(provider), close(external)]);
    }
  });

  it.each(["one-time-url", "paid-search", "rate-limit-api"])(
    "%s 请求状态未知时在任何联网前暂停",
    async (fixture) => {
      let requests = 0;
      const external = createServer((_request, response) => {
        requests += 1;
        response.writeHead(200).end("unexpected");
      });
      await listen(external);
      temporaryRoot(`coremind-external-resume-${fixture}-`);
      const config = resumeConfig(1);
      const args = { url: `http://127.0.0.1:${portOf(external)}/${fixture}` };
      const records = resumeRecords({
        runId: `external-${fixture}`,
        config,
        args,
        capability: externalCapability("unknown"),
        receiptStatuses: ["started", "unknown"],
      });

      try {
        expect(() => prepareRunResume(records, fingerprintRunConfig(config), "继续")).toThrowError(
          expect.objectContaining({ code: "unknown_effect" }),
        );
        expect(requests).toBe(0);
      } finally {
        await close(external);
      }
    },
  );
});

function resumeConfig(providerPort: number): CoreMindConfig {
  return {
    schemaVersion: 2,
    name: "External Resume 验收",
    provider: {
      id: "probe",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      model: "probe-model",
      apiKey: "test-key",
    },
    agents: { main: { systemPrompt: "只按要求调用工具" } },
    workflow: [
      {
        id: "external-step",
        type: "prompt",
        agent: "main",
        input: "继续 {{prompt}}",
        saveAs: "external-result",
      },
    ],
    permissions: { mode: "full", workspaceOnly: true, network: "allow" },
  };
}

function externalCapability(replay: "idempotent" | "unknown"): ResolvedToolCapability {
  return {
    tool: "external_probe",
    effect: "network",
    replay,
    concurrency: "run_serial",
    checkpoint: "none",
    durability: "critical",
    source: "registered",
    resolution: "resolved",
    issues: [],
  };
}

function externalTool(
  request: (url: string) => void | Promise<void>,
  replay: "idempotent" | "unknown" = "idempotent",
): CoreMindToolDefinition<{ url: string }> {
  return {
    name: "external_probe",
    description: "External Resume 本地回环探针",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    effect: { operations: ["network"], reversible: false, urlFields: ["url"] },
    capability: {
      effect: "network",
      replay,
      concurrency: "run_serial",
      checkpoint: "none",
      durability: "critical",
    },
    execute: async ({ url }) => {
      await request(url);
      return { text: "网络结果" };
    },
  };
}

function resumeRecords(input: {
  runId: string;
  config: CoreMindConfig;
  args: { url: string };
  capability: ResolvedToolCapability;
  receiptStatuses: Array<"started" | "committed" | "unknown">;
  completedText?: string;
}): RunStateRecord[] {
  const callId = "old-external-call";
  const turnId = "old-external-turn";
  const idempotencyKey = `${input.runId}:external-step:${callId}`;
  const binding = createEffectReceiptBinding({
    runId: input.runId,
    turnId,
    agent: "main",
    stepId: "external-step",
    callId,
    tool: "external_probe",
    args: input.args,
    capability: input.capability,
  });
  const events: CoreMindEvent[] = [
    {
      type: "capability_resolved",
      agent: "main",
      stepId: "external-step",
      callId,
      tool: "external_probe",
      capability: input.capability,
      recoveryDisposition:
        input.capability.replay === "idempotent" ? "requires_proof" : "requires_human",
    },
    {
      type: "tool_call",
      agent: "main",
      stepId: "external-step",
      turnId,
      callId,
      tool: "external_probe",
      args: input.args,
      argumentsFingerprint: fingerprintEffectReceiptValue(input.args),
      idempotencyKey,
    },
    ...input.receiptStatuses.map(
      (status): CoreMindEvent => ({
        type: "effect_receipt",
        idempotencyKey,
        tool: "external_probe",
        status,
        agent: "main",
        stepId: "external-step",
        turnId,
        callId,
        binding,
      }),
    ),
    ...(input.completedText
      ? [
          {
            type: "step_output" as const,
            stepId: "external-step",
            agent: "main",
            text: input.completedText,
            saveAs: "external-result",
          },
        ]
      : []),
  ];
  const timestamp = "2026-08-23T00:00:00.000Z";
  return [
    {
      version: 1,
      runId: input.runId,
      sequence: 1,
      timestamp,
      kind: "start",
      payload: {
        configFingerprint: fingerprintRunConfig(input.config),
        initialPrompt: "继续",
      },
    },
    ...events.map((event, index) => ({
      version: 1 as const,
      runId: input.runId,
      sequence: index + 2,
      timestamp,
      kind: "event" as const,
      payload: {
        eventId: `external-event-${index + 1}`,
        runId: input.runId,
        sequence: index + 1,
        timestamp,
        event,
      },
    })),
    {
      version: 1,
      runId: input.runId,
      sequence: events.length + 2,
      timestamp,
      kind: "pause",
      payload: { reason: "process_interrupted" },
    },
  ];
}

async function appendRecords(store: FileRunStore, records: RunStateRecord[]): Promise<void> {
  for (const record of records) await store.append(record);
}

function eventFrom(record: RunStateRecord): Array<Record<string, unknown> & { type: string }> {
  if (record.kind !== "event" || record.payload === null || typeof record.payload !== "object") {
    return [];
  }
  const event = (record.payload as { event?: unknown }).event;
  return event && typeof event === "object" && "type" in event
    ? [event as Record<string, unknown> & { type: string }]
    : [];
}

function createToolCallingProvider(tool: string, args: unknown) {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const messages = (JSON.parse(body) as { messages?: Array<{ role?: string }> }).messages ?? [];
      if (messages.some((message) => message.role === "tool")) {
        sendSse(response, [
          {
            id: "external-final",
            choices: [
              { index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: null },
            ],
          },
          { id: "external-final", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
        return;
      }
      sendSse(response, [
        {
          id: "external-tool",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "new-external-call",
                    type: "function",
                    function: { name: tool, arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "external-tool",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ]);
    });
  });
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

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function portOf(server: ReturnType<typeof createServer>): number {
  return (server.address() as AddressInfo).port;
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

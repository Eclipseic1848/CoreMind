import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { resolveToolCapability } from "coremind-tools";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  AgentDriverContextContract,
  AgentDriverDeclarationSelection,
} from "./agent-driver.js";
import { buildAgentDriver } from "./agent-factory.js";
import type { CoreMindEvent } from "./events.js";
import { FactLedger } from "./fact-ledger.js";
import { adaptCoreMindTool } from "./public-tool.js";
import { rebuildRunRequest } from "./rebuild-request.js";
import {
  createProviderRequestReplayFact,
  type ProviderRequestReplayFixture,
  ReplayKit,
} from "./replay-kit.js";
import { FileRunStore, type RunStateRecord } from "./run-state.js";
import type { AgentMessage, Entry } from "./session-v4/index.js";
import {
  ToolDiscoveryExecution,
  type ToolDiscoveryPrepared,
  type ToolDiscoverySearchFact,
} from "./tool-discovery.js";
import { TOOL_DISCOVERY_DECLARATION } from "./tool-discovery-declaration.js";
import { resolveToolDiscoveryRequestDeclaration } from "./tool-discovery-replay.js";

const owner = {
  runId: "discovery-replay-golden",
  agent: "main",
  stepId: "step-1",
  executionId: "native-execution-1",
};
const prefixInput = {
  projectInstructions: "逐次发现并读取工具",
  stableFacts: { fixture: "native" },
  skillsContent: ["只接受真实工具结果"],
};
const capability = {
  effect: "none",
  replay: "safe",
  concurrency: "parallel",
  checkpoint: "none",
  durability: "ordinary",
} as const;
const effect = { operations: ["read" as const], reversible: true };
let fixture: Awaited<ReturnType<typeof captureNativeRequests>>;

beforeAll(async () => {
  fixture = await captureNativeRequests();
});
afterAll(async () => {
  if (fixture)
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

it("真实 native 三请求按各自持久水位重建完整声明与正文，原四指纹金样一致", () => {
  expect(fixture.requests).toHaveLength(3);
  expect(fixture.executed).toEqual(["deferred_z"]);
  const original = structuredClone(fixture.records);
  const replayRequests = fixture.requests.map((request, index) => {
    const declaration = resolveToolDiscoveryRequestDeclaration({
      records: fixture.records,
      owner,
      requestId: request.requestId,
      prefixInput,
    });
    expect(declaration, `第 ${index + 1} 个实际请求应恢复原声明`).toEqual(request.contract);
    const rebuilt = rebuildRunRequest({
      entries: entriesOf(request.messages),
      compactions: [],
      stablePrefix: { text: "不能混入请求的旧固定前缀", fingerprint: "legacy" },
      requestDeclaration: declaration,
    });
    expect(rebuilt).toEqual(request.nativeMessages);
    expect(declaration?.toolSchemas).toEqual(
      (index === 0
        ? ["direct_probe", "discover_tools"]
        : ["deferred_z", "deferred_a", "direct_probe", "discover_tools"]
      ).map((name) => expect.objectContaining({ name })),
    );
    expect(rebuilt.filter((message) => message.role === "system")).toHaveLength(1);
    expect(JSON.stringify(rebuilt)).not.toContain("不能混入请求的旧固定前缀");
    return {
      ...request.replay,
      messages: rebuilt.slice(1),
      stablePrefix: declaration!.stablePrefix,
      toolSchemas: declaration!.toolSchemas,
    };
  });
  const replayed = ReplayKit.replay({ facts: fixture.records, providerRequests: replayRequests });
  expect(replayed.providerRequests).toEqual(
    fixture.requests.map((request) => createProviderRequestReplayFact(request.replay)),
  );
  expect(
    ReplayKit.replay({
      facts: structuredClone(fixture.records),
      providerRequests: structuredClone(replayRequests),
    }),
  ).toEqual(replayed);
  expect(JSON.stringify(replayed)).not.toContain("toolDiscoveryCatalog");
  expect(JSON.stringify(replayed)).not.toContain("参数私有金样");
  expect(fixture.records).toEqual(original);
});

it("声明恢复不反解正文，篡改第二请求正文仍被原 ReplayKit 拒绝", () => {
  const requests = fixture.requests.map((request) => structuredClone(request.replay));
  requests[1]!.messages = [
    ...requests[1]!.messages,
    { role: "user", content: "篡改后的正文", timestamp: 0 },
  ];
  expect(
    resolveToolDiscoveryRequestDeclaration({
      records: fixture.records,
      owner,
      requestId: fixture.requests[1]!.requestId,
      prefixInput,
    }),
  ).toEqual(fixture.requests[1]!.contract);
  expect(() =>
    ReplayKit.replay({ facts: fixture.records, providerRequests: requests }),
  ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
});

it("目标请求之后的错误新代次不会污染先前声明", () => {
  const records = structuredClone(fixture.records);
  const later = records.find((record) => payload(record).toolDiscoverySelection?.generation === 1)!;
  payload(later).toolDiscoverySelection.previousFingerprint = "f".repeat(64);
  expect(
    resolveToolDiscoveryRequestDeclaration({
      records,
      owner,
      requestId: fixture.requests[0]!.requestId,
      prefixInput,
    }),
  ).toEqual(fixture.requests[0]!.contract);
});

it.each([
  "schema",
  "chain",
  "generation",
  "catalog",
  "summary",
  "prefix",
  "request-schema",
  "missing-snapshot",
] as const)("拒绝目标请求的 %s 漂移，不把当前配置当作历史声明", (change) => {
  const records = structuredClone(fixture.records);
  const first = records.find((record) => payload(record).toolDiscoveryCatalog)!;
  const installed = records.find(
    (record) => payload(record).toolDiscoverySelection?.generation === 1,
  )!;
  const request = records.find(
    (record) => payload(record).event?.requestId === fixture.requests[1]!.requestId,
  )!;
  if (change === "schema")
    payload(
      first,
    ).toolDiscoveryCatalog.entries[0].declaration.parameters.properties.path.description =
      "被改写的旧 schema";
  if (change === "chain")
    payload(installed).toolDiscoverySelection.previousFingerprint = "f".repeat(64);
  if (change === "generation") payload(request).event.toolDiscovery.generation = 0;
  if (change === "catalog")
    payload(request).event.toolDiscovery.catalogFingerprint = "f".repeat(64);
  if (change === "summary") payload(request).event.toolDiscovery.toolCount = 99;
  if (change === "prefix") payload(request).event.stablePrefixFingerprint = "f".repeat(64);
  if (change === "request-schema") payload(request).event.toolSchemaFingerprint = "f".repeat(64);
  if (change === "missing-snapshot") delete payload(first).toolDiscoveryCatalog;
  expect(() =>
    resolveToolDiscoveryRequestDeclaration({
      records,
      owner,
      requestId: fixture.requests[1]!.requestId,
      prefixInput,
    }),
  ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
});

it.each(["runId", "agent", "stepId", "executionId"] as const)(
  "目标请求不能由另一 %s 的目录恢复",
  (key) => {
    expect(() =>
      resolveToolDiscoveryRequestDeclaration({
        records: fixture.records,
        owner: { ...owner, [key]: "another-owner" },
        requestId: fixture.requests[1]!.requestId,
        prefixInput,
      }),
    ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
  },
);

it("重复或缺失的目标 requestId 明确拒绝", () => {
  const records = structuredClone(fixture.records);
  const request = records.find(
    (record) => payload(record).event?.requestId === fixture.requests[1]!.requestId,
  )!;
  records.push({ ...structuredClone(request), sequence: records.length + 1 });
  expect(() =>
    resolveToolDiscoveryRequestDeclaration({
      records,
      owner,
      requestId: fixture.requests[1]!.requestId,
      prefixInput,
    }),
  ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
  expect(() =>
    resolveToolDiscoveryRequestDeclaration({
      records: fixture.records,
      owner,
      requestId: "missing-request",
      prefixInput,
    }),
  ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
});

it("旧请求没有声明元数据时继续使用旧重建器，不推测激活集合", () => {
  const records = structuredClone(fixture.records);
  const request = records.find(
    (record) => payload(record).event?.requestId === fixture.requests[0]!.requestId,
  )!;
  delete payload(request).event.toolDiscovery;
  expect(
    resolveToolDiscoveryRequestDeclaration({
      records,
      owner,
      requestId: fixture.requests[0]!.requestId,
      prefixInput,
    }),
  ).toBeUndefined();
  const rebuilt = rebuildRunRequest({
    entries: [],
    compactions: [],
    stablePrefix: { text: "旧固定前缀", fingerprint: "old" },
  });
  expect(rebuilt).toEqual([{ role: "system", content: "旧固定前缀", timestamp: 0 }]);
});

async function captureNativeRequests() {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-discovery-replay-"));
  try {
    const store = new FileRunStore(directory);
    const ledger = new FactLedger(owner.runId, store);
    await ledger.append("start", { configName: "真实声明回放" });
    let traceSequence = 0;
    const appendEvent = (
      event: CoreMindEvent,
      extra: Record<string, unknown> = {},
      prepared?: ToolDiscoveryPrepared,
    ) => {
      const sequence = ++traceSequence;
      const eventId = prepared?.eventId ?? `native-event-${sequence}`;
      return ledger.append(
        "event",
        {
          eventId,
          runId: owner.runId,
          sequence,
          timestamp: new Date(0).toISOString(),
          event,
          ...extra,
        },
        { durability: prepared || extra.toolDiscoverySearch ? "critical" : "ordinary", eventId },
      );
    };
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("discover_tools", { query: "读取" })]),
      fauxAssistantMessage([fauxToolCall("deferred_z", { path: "notes.txt" })]),
      fauxAssistantMessage("已完成"),
    ]);
    const nativeMessages: Array<Parameters<typeof models.streamSimple>[1]["messages"]> = [];
    const stream = models.streamSimple.bind(models);
    models.streamSimple = ((...args) => {
      nativeMessages.push(structuredClone(args[1].messages));
      return stream(...args);
    }) as typeof models.streamSimple;
    const executed: string[] = [];
    const business = ["deferred_z", "deferred_a", "direct_probe"].map((name) =>
      adaptCoreMindTool({
        name,
        description: name === "direct_probe" ? "固定直接工具" : "读取已授权数据",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", enum: ["notes.txt", "订单.txt"], description: "参数私有金样" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        effect,
        capability,
        execute: async () => {
          executed.push(name);
          return { text: "真实目标结果", details: { name } };
        },
      }),
    );
    let discovery!: ToolDiscoveryExecution;
    let initial: ToolDiscoveryPrepared | undefined;
    let current!: AgentDriverContextContract;
    const durableSearches: ToolDiscoverySearchFact[] = [];
    const writes: Promise<unknown>[] = [];
    const requests: Array<{
      requestId: string;
      contract: AgentDriverContextContract;
      nativeMessages: AgentMessage[];
      messages: readonly unknown[];
      replay: ProviderRequestReplayFixture;
    }> = [];
    const selection = (
      value: ToolDiscoveryPrepared["selection"],
    ): AgentDriverDeclarationSelection => ({
      names: [...value.names, "discover_tools"],
      generation: value.generation,
      fingerprint: value.fingerprint,
    });
    const summary = () => ({
      version: 1 as const,
      catalogFingerprint: discovery.catalog.fingerprint,
      generation: discovery.current!.generation,
      selectionFingerprint: discovery.current!.fingerprint,
      toolCount: discovery.current!.names.length + 1,
    });
    const meta = adaptCoreMindTool({
      ...structuredClone(TOOL_DISCOVERY_DECLARATION),
      effect,
      capability: { ...capability, durability: "critical" },
      execute: async (args, call) => {
        const result = discovery.search(call.callId, args, call.signal);
        return { text: (result.content[0] as { text: string }).text, details: result.details };
      },
    });
    const driver = buildAgentDriver(
      { systemPrompt: prefixInput.projectInstructions },
      {
        models,
        model: faux.getModel(),
        tools: [...business, meta],
        agentName: owner.agent,
        skillsContent: prefixInput.skillsContent,
        stableFacts: prefixInput.stableFacts,
        onEvent: () => {},
        harness: {
          registerDeclarationCatalog: (catalog) => {
            discovery = new ToolDiscoveryExecution({
              owner,
              entries: catalog
                .filter((entry) => entry.name !== "discover_tools")
                .map((entry) => ({
                  ...entry,
                  declaration: entry.declaration as Record<string, unknown>,
                  exposure: entry.name === "direct_probe" ? "direct" : "deferred",
                  sourceIdentity: `source:${entry.name}`,
                  effect,
                  capability: resolveToolCapability({
                    tool: entry.name,
                    source: "registered",
                    declaration: capability,
                  }),
                })),
            });
            initial = discovery.prepare([])!;
            return selection(initial.selection);
          },
          registerContextContract: (contract) => {
            current = contract;
          },
          prepareRequest: async (prepare) => {
            await Promise.all(writes);
            const prepared = initial ?? discovery.prepare(durableSearches);
            if (!prepared) return undefined;
            const selected = selection(prepared.selection);
            const contract = prepare(selected);
            const receipt = await appendEvent(
              {
                type: "context_prefix",
                agent: owner.agent,
                fingerprint: createHash("sha256")
                  .update(contract.stablePrefix, "utf8")
                  .digest("hex"),
                toolDiscovery: {
                  version: 1,
                  catalogFingerprint: prepared.selection.catalogFingerprint,
                  generation: prepared.selection.generation,
                  selectionFingerprint: prepared.selection.fingerprint,
                  toolCount: selected.names.length,
                },
              },
              {
                ...(prepared.catalog ? { toolDiscoveryCatalog: prepared.catalog } : {}),
                toolDiscoverySelection: prepared.selection,
              },
              prepared,
            );
            discovery.commit(prepared, receipt);
            initial = undefined;
            return selected;
          },
          onObservation: (observation) => {
            const search = discovery?.observe(observation);
            if (!search || observation.type !== "tool_execution_end") return;
            writes.push(
              appendEvent(
                {
                  type: "tool_result",
                  agent: owner.agent,
                  stepId: owner.stepId,
                  tool: observation.call.tool,
                  callId: observation.call.callId,
                  isError: false,
                },
                { toolDiscoverySearch: search },
              ).then(() => {
                durableSearches.push(search);
              }),
            );
          },
          onModelRequestDispatched: ({ providerId, modelId, messages }) => {
            const requestId = `${owner.agent}:${owner.stepId}:${owner.executionId}:${requests.length + 1}`;
            const replay = {
              requestId,
              providerId,
              modelId,
              messages: structuredClone(messages),
              stablePrefix: current.stablePrefix,
              toolSchemas: structuredClone(current.toolSchemas),
              capabilityFingerprint: "native-capability-golden",
            };
            requests.push({
              requestId,
              contract: structuredClone(current),
              messages: replay.messages,
              nativeMessages: nativeMessages[requests.length]! as AgentMessage[],
              replay,
            });
            writes.push(
              appendEvent({
                type: "provider_request",
                agent: owner.agent,
                stepId: owner.stepId,
                ...createProviderRequestReplayFact(replay),
                toolDiscovery: summary(),
              }),
            );
          },
        },
      },
    );
    await driver.prompt("先发现，再读取 notes.txt");
    await driver.waitForIdle();
    await Promise.all(writes);
    await ledger.flush();
    return { directory, records: await store.read(owner.runId), requests, executed };
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    throw error;
  }
}

function entriesOf(messages: readonly unknown[]): Entry[] {
  return messages.map((message, index) => ({
    type: "message",
    id: `message-${index + 1}`,
    parentId: index === 0 ? null : `message-${index}`,
    seq: index + 1,
    timestamp: 0,
    message: structuredClone(message) as AgentMessage,
  }));
}

function payload(record: RunStateRecord): any {
  return record.payload;
}

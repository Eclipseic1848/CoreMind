import "../../../test/setup-env.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import {
  FileRunStore,
  fingerprintRunConfig,
  prepareRunResume,
  type RunStateRecord,
} from "./run-state.js";
import { CoreMindRuntime, type RunResult } from "./runtime.js";
import type { ToolDiscoveryCatalog, ToolDiscoverySelection } from "./tool-discovery.js";
import { TOOL_DISCOVERY_DECLARATION } from "./tool-discovery-declaration.js";
import { resolveToolDiscoveryRequestDeclaration } from "./tool-discovery-replay.js";
import type { ToolApprovalRequest } from "./tool-policy.js";

interface Request {
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function: { name: string; description: string; parameters: unknown } }>;
}
type ProviderRequest = Extract<CoreMindEvent, { type: "provider_request" }>;
type Reply = string | { name: string; args: unknown };
const stepId = "quality-read";
const projectInstructions = "每次独立执行先发现工具，再按宿主审批读取文件";
const body = "冷恢复后真实授权读取正文 retry-boundary-canary";
const prefixInput = {
  projectInstructions,
  stableFacts: { provider: "discovery-retry-probe", model: "probe", contextWindow: 32768 },
  skillsContent: [],
};
let fixture: Awaited<ReturnType<typeof captureWorkflowRetry>>;

beforeAll(async () => {
  fixture = await captureWorkflowRetry();
});
afterAll(async () => {
  if (fixture) await fixture.close();
});

it("真实质量重试隔离同 scope 的每次声明，并为每个已发请求保留唯一身份", () => {
  expect(fixture.paused.outcome).toMatchObject({
    status: "paused",
    finishReason: "tool_approval_denied",
  });
  expect(
    fixture.paused.trace.filter(({ event }) => event.type === "retry").map(({ event }) => event),
  ).toEqual([expect.objectContaining({ type: "retry", scope: "workflow", stepId, attempt: 1 })]);
  expect(fixture.requests.slice(0, 4).map(names)).toEqual([
    ["discover_tools"],
    ["read", "discover_tools"],
    ["discover_tools"],
    ["read", "discover_tools"],
  ]);
  const catalogs = catalogsOf(fixture.pausedRecords);
  expect(catalogs).toHaveLength(2);
  expect(catalogs.map((catalog) => catalog.owner)).toEqual([
    expect.objectContaining({ runId: fixture.paused.runId, agent: "main", stepId }),
    expect.objectContaining({ runId: fixture.paused.runId, agent: "main", stepId }),
  ]);
  expect(catalogs[0]!.owner).not.toEqual(catalogs[1]!.owner);
  expect(new Set(catalogs.map((catalog) => catalog.fingerprint)).size).toBe(2);
  for (const catalog of catalogs) {
    const selections = selectionsOf(fixture.pausedRecords).filter(
      (selection) => selection.catalogFingerprint === catalog.fingerprint,
    );
    expect(selections.map((selection) => selection.generation)).toEqual([0, 1]);
    expect(selections.map((selection) => selection.names)).toEqual([[], ["read"]]);
  }
  const requests = providerRequestsOf(fixture.pausedRecords);
  expect(requests).toHaveLength(4);
  expect(new Set(requests.map((request) => request.requestId)).size).toBe(requests.length);
});

it("重试后的拒绝暂停可由同配置新 Runtime 冷恢复，沿未完成执行读取且原 Facts 只追加", async () => {
  expect(fixture.resumeError).toBeUndefined();
  expect(
    fixture.resumed?.outcome,
    JSON.stringify({ resumeError: fixture.resumeError, outcome: fixture.resumed?.outcome }),
  ).toMatchObject({ status: "succeeded" });
  expect(fixture.resumed!.runId).toBe(fixture.paused.runId);
  expect(fixture.requests).toHaveLength(6);
  expect(names(fixture.requests[4]!)).toEqual(["read", "discover_tools"]);
  expect(fixture.requests[5]!.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: "tool", content: expect.stringContaining(body) }),
    ]),
  );
  expect(JSON.stringify(fixture.requests.slice(0, 5))).not.toContain(body);
  expect(fixture.approvals.map(({ tool, runId }) => ({ tool, runId }))).toEqual([
    { tool: "read", runId: fixture.paused.runId },
    { tool: "read", runId: fixture.paused.runId },
  ]);
  const catalogs = catalogsOf(fixture.records);
  expect(catalogs).toHaveLength(2);
  expect(fixture.records.slice(0, fixture.pausedRecords.length)).toEqual(fixture.pausedRecords);
  expect(fixture.finalBytes.startsWith(fixture.pausedBytes)).toBe(true);
  expect(await new FileRunStore(fixture.storeDirectory).read(fixture.paused.runId)).toEqual(
    fixture.records,
  );
  const requests = providerRequestsOf(fixture.records);
  expect(requests).toHaveLength(6);
  expect(new Set(requests.map((request) => request.requestId)).size).toBe(6);
  const resumedRequest = requests[4]!;
  expect(resumedRequest.toolDiscovery?.catalogFingerprint).toBe(catalogs[1]!.fingerprint);
  expect(resumedRequest.toolDiscovery?.selectionFingerprint).toBe(
    requests[3]!.toolDiscovery?.selectionFingerprint,
  );
});

it("重试前后及恢复后的每个真实请求按自身水位恢复完整 schema 与前缀金样，读取不改 Facts", () => {
  const original = structuredClone(fixture.records);
  const requests = providerRequestsOf(fixture.records);
  expect(requests.length).toBeGreaterThanOrEqual(4);
  const catalogs = catalogsOf(fixture.records);
  for (const [index, request] of requests.entries()) {
    const catalog = catalogs.find(
      (entry) => entry.fingerprint === request.toolDiscovery?.catalogFingerprint,
    );
    expect(catalog, `实际请求 ${request.requestId} 必须有原目录快照`).toBeDefined();
    const record = fixture.records.find((entry) => eventOf(entry) === request)!;
    const atWatermark = fixture.records.filter((entry) => entry.sequence <= record.sequence);
    const contract = resolveToolDiscoveryRequestDeclaration({
      records: fixture.records,
      owner: catalog!.owner,
      requestId: request.requestId,
      prefixInput,
    });
    expect(
      resolveToolDiscoveryRequestDeclaration({
        records: atWatermark,
        owner: catalog!.owner,
        requestId: request.requestId,
        prefixInput,
      }),
    ).toEqual(contract);
    const wire = fixture.requests[index]!;
    expect(contract?.stablePrefix).toBe(
      wire.messages.find((message) => message.role === "system")?.content,
    );
    const expectedNames =
      index === 0 || index === 2 ? ["discover_tools"] : ["read", "discover_tools"];
    expect(contract?.toolSchemas.map((schema) => (schema as { name: string }).name)).toEqual(
      expectedNames,
    );
    const expectedSchemas = expectedNames.map((name) =>
      name === "discover_tools"
        ? TOOL_DISCOVERY_DECLARATION
        : catalog!.entries.find((entry) => entry.name === name)!.declaration,
    );
    expect(contract?.toolSchemas).toEqual(expectedSchemas);
    expect(
      contract?.toolSchemas.map((schema) => {
        const declaration = schema as { name: string; description: string; parameters: unknown };
        return {
          name: declaration.name,
          description: declaration.description,
          parameters: declaration.parameters,
        };
      }),
    ).toEqual(
      wire.tools?.map(({ function: declaration }) => ({
        name: declaration.name,
        description: declaration.description,
        parameters: declaration.parameters,
      })),
    );
  }
  expect(fixture.records).toEqual(original);
});

it("没有最终 pause 绑定的真实崩溃前缀沿原 Recovery 恢复为新执行，不继承旧 read 激活", async () => {
  const originalRecords = structuredClone(fixture.records);
  const recovered = await fixture.recoverWithoutPause();
  expect(recovered.result.outcome, JSON.stringify(recovered.result.outcome)).toMatchObject({
    status: "succeeded",
  });
  expect(recovered.result.runId).toBe(fixture.paused.runId);
  expect(recovered.requests.map(names)).toEqual([["discover_tools"]]);
  expect(JSON.stringify(recovered.requests)).not.toContain(body);
  const catalogs = catalogsOf(recovered.records);
  const oldCatalogs = catalogsOf(fixture.pausedRecords);
  expect(catalogs).toHaveLength(oldCatalogs.length + 1);
  expect(catalogs.slice(0, oldCatalogs.length)).toEqual(oldCatalogs);
  const fresh = catalogs.at(-1)!;
  expect(oldCatalogs.map((catalog) => catalog.owner.executionId)).not.toContain(
    fresh.owner.executionId,
  );
  expect(oldCatalogs.map((catalog) => catalog.fingerprint)).not.toContain(fresh.fingerprint);
  expect(
    selectionsOf(recovered.records).filter(
      (selection) => selection.catalogFingerprint === fresh.fingerprint,
    ),
  ).toEqual([expect.objectContaining({ generation: 0, names: [] })]);
  const requests = providerRequestsOf(recovered.records);
  expect(requests).toHaveLength(5);
  expect(new Set(requests.map((request) => request.requestId)).size).toBe(5);
  expect(requests.at(-1)!.toolDiscovery?.catalogFingerprint).toBe(fresh.fingerprint);
  expect(recovered.records.slice(0, recovered.prefix.length)).toEqual(recovered.prefix);
  expect(fixture.records).toEqual(originalRecords);
  expect(
    await readFile(path.join(fixture.storeDirectory, `${fixture.paused.runId}.jsonl`), "utf8"),
  ).toBe(fixture.finalBytes);
});

function names(request: Request) {
  return request.tools?.map((tool) => tool.function.name) ?? [];
}
function eventOf(record: RunStateRecord) {
  return record.kind === "event" ? (record.payload as { event?: CoreMindEvent }).event : undefined;
}
function providerRequestsOf(records: readonly RunStateRecord[]): ProviderRequest[] {
  return records.flatMap((record) => {
    const event = eventOf(record);
    return event?.type === "provider_request" ? [event] : [];
  });
}
function catalogsOf(records: readonly RunStateRecord[]) {
  return records.flatMap((record) => {
    const catalog = (record.payload as { toolDiscoveryCatalog?: ToolDiscoveryCatalog })
      .toolDiscoveryCatalog;
    return catalog ? [catalog] : [];
  });
}
function selectionsOf(records: readonly RunStateRecord[]) {
  return records.flatMap((record) => {
    const selection = (record.payload as { toolDiscoverySelection?: ToolDiscoverySelection })
      .toolDiscoverySelection;
    return selection ? [selection] : [];
  });
}

async function captureWorkflowRetry() {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-discovery-retry-"));
  const storeDirectory = path.join(directory, "runs");
  const requests: Request[] = [];
  const failures: unknown[] = [];
  const approvals: ToolApprovalRequest[] = [];
  let crashRequests: Request[] | undefined;
  const controller = new AbortController();
  const running: Promise<RunResult>[] = [];
  const runtimes: CoreMindRuntime[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      try {
        const captured = crashRequests ?? requests;
        captured.push(JSON.parse(text) as Request);
        const round = captured.length;
        const reply: Reply = crashRequests
          ? "质量合格，独立声明完成"
          : round === 1 || round === 3
            ? { name: "discover_tools", args: { query: "read" } }
            : round === 2
              ? "需重试：首份候选不通过质量检查"
              : round === 4 || round === 5
                ? { name: "read", args: { path: "notes.txt" } }
                : round === 6
                  ? "质量合格，读取完成"
                  : (() => {
                      throw new Error("出现未计划的真实模型请求");
                    })();
        const delta =
          typeof reply === "string"
            ? { role: "assistant", content: reply }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `retry-call-${round}`,
                    type: "function",
                    function: { name: reply.name, arguments: JSON.stringify(reply.args) },
                  },
                ],
              };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [change, finish] of [
          [delta, null],
          [{}, typeof reply === "string" ? "stop" : "tool_calls"],
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: `retry-reply-${round}`,
              choices: [{ index: 0, delta: change, finish_reason: finish }],
            })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      } catch (error) {
        failures.push(error);
        response.writeHead(500).end();
      }
    });
  });
  const close = async () => {
    controller.abort();
    await Promise.allSettled(running);
    await Promise.all(runtimes.map((runtime) => runtime.waitForQuiescence()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith("coremind-discovery-retry-")
    )
      throw new Error("临时验收目录越界，拒绝清理");
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  };
  try {
    await writeFile(path.join(directory, "notes.txt"), body, "utf8");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const config: CoreMindConfig = {
      schemaVersion: 3,
      name: "发现声明质量重试冷恢复",
      provider: {
        id: prefixInput.stableFacts.provider,
        model: prefixInput.stableFacts.model,
        contextWindow: prefixInput.stableFacts.contextWindow,
        apiKeyEnv: "COREMIND_TEST_API_KEY",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      },
      agents: {
        main: { systemPrompt: projectInstructions, tools: [{ id: "read", exposure: "deferred" }] },
      },
      workflow: [
        {
          id: stepId,
          type: "prompt",
          agent: "main",
          input: "{{prompt}}",
          retry: { max: 1, if: "{{text}} contains 需重试" },
        },
      ],
      permissions: { mode: "ask", allow: ["discover_tools"], workspaceOnly: true, network: "deny" },
      runtime: {
        maxTurns: 8,
        maxSteps: 4,
        maxToolCalls: 8,
        maxTokens: 16_000,
        maxRetries: 1,
        runTimeoutMs: 15_000,
      },
    };
    const run = async (resumeRunId?: string, selectedStoreDirectory = storeDirectory) => {
      const runtime = await CoreMindRuntime.create({
        config,
        cwd: directory,
        configDir: directory,
        initialPrompt: "发现并读取 notes.txt",
        signal: controller.signal,
        runStore: new FileRunStore(selectedStoreDirectory),
        ...(resumeRunId ? { resumeRunId } : {}),
        approveTool: async (request) => {
          approvals.push(request);
          return resumeRunId ? "allow" : "deny";
        },
      });
      runtimes.push(runtime);
      const promise = runtime.run();
      running.push(promise);
      const result = await promise;
      expect(await runtime.waitForQuiescence()).toBe(true);
      return result;
    };
    const paused = await run();
    const pausedRecords = await new FileRunStore(storeDirectory).read(paused.runId);
    const pausedBytes = await readFile(path.join(storeDirectory, `${paused.runId}.jsonl`), "utf8");
    let resumed: RunResult | undefined;
    let resumeError: unknown;
    try {
      resumed = await run(paused.runId);
    } catch (error) {
      resumeError = error;
    }
    const records = await new FileRunStore(storeDirectory).read(paused.runId);
    const finalBytes = await readFile(path.join(storeDirectory, `${paused.runId}.jsonl`), "utf8");
    expect(failures).toEqual([]);
    const recoverWithoutPause = async () => {
      expect(pausedRecords.at(-1)?.kind).toBe("pause");
      const prefix = pausedRecords.slice(0, -1);
      expect(prefix.at(-1)?.kind).not.toBe("pause");
      // 复制真实前缀到新 Store，保留原 Recovery 检查和原事实，模拟暂停绑定尚未落盘。
      expect(
        prepareRunResume(prefix, fingerprintRunConfig(config), "发现并读取 notes.txt").runId,
      ).toBe(paused.runId);
      const crashStoreDirectory = path.join(directory, "crash-runs");
      const crashStore = new FileRunStore(crashStoreDirectory);
      for (const record of prefix) await crashStore.append(structuredClone(record));
      await crashStore.barrier(paused.runId, "critical");
      expect(await crashStore.read(paused.runId)).toEqual(prefix);
      const captured: Request[] = [];
      crashRequests = captured;
      try {
        const result = await run(paused.runId, crashStoreDirectory);
        expect(failures).toEqual([]);
        return {
          result,
          requests: captured,
          prefix,
          records: await new FileRunStore(crashStoreDirectory).read(paused.runId),
        };
      } finally {
        crashRequests = undefined;
      }
    };
    return {
      directory,
      storeDirectory,
      requests,
      approvals,
      paused,
      resumed,
      resumeError,
      pausedRecords,
      records,
      pausedBytes,
      finalBytes,
      recoverWithoutPause,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

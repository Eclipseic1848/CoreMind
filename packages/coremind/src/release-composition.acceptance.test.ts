import "../../../test/setup-env.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CoreMindConfig,
  type CoreMindEvent,
  CoreMindRuntime,
  type CoreMindTraceEvent,
  createProviderRequestReplayFact,
  FileRunStore,
  fingerprintRunConfig,
  ProjectionEngine,
  prepareRunResume,
  type RunStateRecord,
  type RunStoreDurability,
  type RunStoreDurabilityAcknowledgement,
  type ToolApprovalRequest,
} from "coremind-ai";
import { expect, it, vi } from "vitest";

const skillId = "release-composition-skill";
const skillBody = "冻结的组合技能正文：中文🙂。这里只交付说明，不增加工具或权限。\n";
const skillBodySha = sha256(skillBody);
const steering = "唯一追加指令：按审批读取，保留声明与预算边界";
const credentialCanary = "composition-file-credential-canary";
const noteA = "首轮真实文件正文";
const noteB = "恢复后独立审批读取的真实正文";
const initialPrompt = "加载技能，按需发现并读取两个文件，再执行受限委派。";
const childBudget = {
  tokens: 4_000,
  toolCalls: 2,
  costUsd: 0.5,
  wallTimeMs: 10_000,
  steps: 3,
  descendants: 0,
};

interface Declaration {
  name: string;
  description: string;
  parameters: unknown;
}
interface WireRequest {
  model: string;
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: Declaration }>;
}
interface Catalog {
  fingerprint: string;
  owner: { runId: string; agent: string; executionId: string; stepId?: string };
  entries: Array<{ name: string; exposure: string; declaration: Declaration }>;
}
interface Selection {
  fingerprint: string;
  catalogFingerprint: string;
  generation: number;
  names: string[];
}
type Result = Awaited<ReturnType<CoreMindRuntime["run"]>>;
type ProviderRequest = Extract<CoreMindEvent, { type: "provider_request" }>;
type Call = { id: string; name: string; args: Record<string, unknown> };

it("真实组合：技能与延迟声明、审批中steering、冷恢复及受限Child后取消均保持原事实和权限", async () => {
  const directory = ownedTemporaryDirectory(
    await mkdtemp(path.join(tmpdir(), "coremind-release-composition-")),
  );
  const runId = "release-composition-parent";
  const storeDirectory = path.join(directory, "runs");
  const skillSource = path.join(directory, "skills", skillId, "SKILL.md");
  const requests: WireRequest[] = [];
  const parentRequests: WireRequest[] = [];
  const childRequests: WireRequest[] = [];
  const failures: unknown[] = [];
  const approvals: ToolApprovalRequest[] = [];
  const live: CoreMindTraceEvent[] = [];
  const sockets = new Set<Socket>();
  let finalResponseClosed = false;
  const approvalEntered = deferred<void>();
  const firstApproval = deferred<"allow" | "deny">();
  const finalRequest = deferred<void>();
  const controllers = [new AbortController(), new AbortController()];
  const runtimes: CoreMindRuntime[] = [];
  const running: Promise<Result>[] = [];
  const commits: Array<{
    record: RunStateRecord;
    requested: RunStoreDurability;
    acknowledgement: RunStoreDurabilityAcknowledgement;
  }> = [];
  const commit = FileRunStore.prototype.commit;
  const commitSpy = vi.spyOn(FileRunStore.prototype, "commit").mockImplementation(async function (
    this: FileRunStore,
    record,
    requested,
  ) {
    const acknowledgement = await commit.call(this, record, requested);
    commits.push({ record, requested, acknowledgement });
    return acknowledgement;
  });
  let resumedPhase = false;
  let verified = false;
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      void (async () => {
        const wire = JSON.parse(text) as WireRequest;
        requests.push(wire);
        if (wire.model === "composition-child") {
          childRequests.push(wire);
          expect(names(wire)).toEqual(["discover_tools"]);
          expect(JSON.stringify(wire.messages)).not.toContain(skillBody);
          expect(JSON.stringify(wire)).not.toContain(credentialCanary);
          if (childRequests.length === 1) {
            sendCalls(response, [
              { id: "child-search-read", name: "discover_tools", args: { query: "read" } },
              { id: "child-guessed-read", name: "read", args: { path: ".env" } },
            ]);
          } else {
            expect(childRequests).toHaveLength(2);
            expect(searchResult(wire)).toMatchObject({ matches: [], truncated: false });
            sendText(response, "子任务确认自己没有读取权限");
          }
          return;
        }
        expect(wire.model).toBe("composition-parent");
        parentRequests.push(wire);
        const round = parentRequests.length;
        expect(names(wire)).not.toContain("write");
        if (round === 1 || round === 2) {
          expect(names(wire).sort()).toEqual([
            "delegate",
            "discover_tools",
            "dispose_delegation",
            "load_skill",
          ]);
        } else {
          expect(names(wire).sort()).toEqual([
            "delegate",
            "discover_tools",
            "dispose_delegation",
            "load_skill",
            "read",
          ]);
        }
        if (round === 1 || round === 5) {
          expect(JSON.stringify(wire.messages)).not.toContain(skillBody);
          expect(JSON.stringify(wire.messages)).toContain(skillBodySha);
          sendCalls(response, [
            { id: `main-load-${round}`, name: "load_skill", args: { id: skillId } },
          ]);
        } else if (round === 2) {
          expect(toolText(wire)).toContain(skillBody);
          const durable = await new FileRunStore(storeDirectory).read(runId);
          const load = durable.find((record) => metadata(record).skillLoad !== undefined);
          assert(load, "下一请求前必须已有原技能加载事实");
          for (const record of [durable.find((entry) => entry.kind === "start")!, load]) {
            expect(
              commits.find(
                (entry) =>
                  entry.record === record ||
                  (entry.record.runId === record.runId &&
                    entry.record.sequence === record.sequence),
              ),
            ).toMatchObject({
              requested: "critical",
              acknowledgement: { achieved: "critical", boundary: "process_crash" },
            });
          }
          sendCalls(response, [
            { id: "main-discover-read", name: "discover_tools", args: { query: "read" } },
          ]);
        } else if (round === 3) {
          expect(searchResult(wire)).toMatchObject({
            matches: [expect.objectContaining({ name: "read" })],
          });
          sendCalls(response, [{ id: "main-read-a", name: "read", args: { path: "note-a.txt" } }]);
        } else if (round === 4) {
          expect(toolText(wire)).toContain(noteA);
          expect(userTexts(wire).filter((value) => value === steering)).toHaveLength(1);
          sendCalls(response, [
            { id: "main-read-b-denied", name: "read", args: { path: "note-b.txt" } },
          ]);
        } else if (round === 6) {
          expect(resumedPhase).toBe(true);
          expect(toolText(wire)).toContain(skillBody);
          sendCalls(response, [
            { id: "main-read-b-resumed", name: "read", args: { path: "note-b.txt" } },
          ]);
        } else if (round === 7) {
          expect(toolText(wire)).toContain(noteB);
          sendCalls(response, [
            {
              id: "main-delegate",
              name: "delegate",
              args: {
                target: "researcher",
                task: "仅检查你自己的read目录，不得获取父技能或读取.env。",
                references: [],
                limits: { ...childBudget, maxDepth: 1, maxActiveChildren: 0 },
              },
            },
          ]);
        } else {
          expect(round).toBe(8);
          expect(childRequests).toHaveLength(2);
          const records = await new FileRunStore(storeDirectory).read(runId);
          expect(
            records.some(
              (record) => record.kind === "delegation" && metadata(record).type === "parent_joined",
            ),
          ).toBe(true);
          response.once("close", () => {
            finalResponseClosed = true;
          });
          response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
          response.flushHeaders();
          // 原请求保持等待，只有真正的调用方取消或 finally 清理才能关闭。
          finalRequest.resolve();
        }
      })().catch((error: unknown) => {
        failures.push(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  try {
    await mkdir(path.dirname(skillSource), { recursive: true });
    await writeFile(
      skillSource,
      `---\nname: 发布组合技能\ndescription: 读取与恢复的冻结说明\n---\n${skillBody}`,
      "utf8",
    );
    await writeFile(path.join(directory, "note-a.txt"), noteA, "utf8");
    await writeFile(path.join(directory, "note-b.txt"), noteB, "utf8");
    await writeFile(
      path.join(directory, ".env"),
      `COMPOSITION_SECRET=${credentialCanary}\n`,
      "utf8",
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const config: CoreMindConfig = {
      schemaVersion: 3,
      name: "发布真实组合验收",
      provider: {
        id: "probe",
        model: "composition-parent",
        contextWindow: 16_384,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKeyEnv: "COREMIND_TEST_API_KEY",
      },
      agents: {
        main: {
          systemPrompt: "按固定技能与实际批准执行，发现不增加权限。",
          skills: [skillId],
          options: { maxTokens: 256 },
          tools: [
            { id: "read", exposure: "deferred" },
            { id: "write", exposure: "deferred" },
          ],
          delegation: {
            budget: {
              tokens: 8_000,
              toolCalls: 4,
              costUsd: 1,
              wallTimeMs: 20_000,
              steps: 4,
              descendants: 1,
            },
            limits: { maxDepth: 1, maxActiveChildren: 1, maxDescendants: 1 },
            targets: { researcher: { budget: childBudget } },
          },
        },
        researcher: {
          systemPrompt: "只检查自己已授权的工具目录。",
          model: "composition-child",
          options: { maxTokens: 256 },
          tools: [{ id: "write", exposure: "deferred" }],
        },
      },
      defaultAgent: "main",
      session: { enabled: false },
      runtime: {
        maxTurns: 12,
        maxSteps: 8,
        maxToolCalls: 16,
        maxTokens: 20_000,
        maxCostUsd: 3,
        maxRetries: 0,
        runTimeoutMs: 30_000,
      },
      permissions: {
        mode: "ask",
        allow: ["load_skill", "discover_tools"],
        workspaceOnly: true,
        network: "deny",
      },
    };
    const originalConfig = structuredClone(config);
    const create = async (resume: boolean) => {
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        initialPrompt,
        env: { COREMIND_TEST_API_KEY: "composition-provider-credential" },
        runStore: new FileRunStore(storeDirectory),
        signal: controllers[resume ? 1 : 0]!.signal,
        ...(resume ? { resumeRunId: runId } : { runId }),
        trace: (entry) => {
          live.push(structuredClone(entry));
        },
        approveTool: async (request) => {
          approvals.push(structuredClone(request));
          expect(request.runId).toBe(runId);
          if (request.tool === "delegate") {
            expect(request.args).toMatchObject({ target: "researcher", limits: childBudget });
            return "allow";
          }
          expect(request.tool).toBe("read");
          const args = request.args as { path: string };
          if (args.path === "note-a.txt") {
            approvalEntered.resolve();
            return firstApproval.promise;
          }
          expect(args.path).toBe("note-b.txt");
          return resume ? "allow" : "deny";
        },
      });
      runtimes.push(runtime);
      const promise = runtime.run();
      running.push(promise);
      return { runtime, promise };
    };
    const first = await create(false);
    await reached(approvalEntered.promise, first.promise, "首个read未进入实际审批", failures);
    expect(parentRequests).toHaveLength(3);
    expect(
      await first.runtime.acceptControl({
        schemaVersion: 1,
        runId,
        controlId: "composition-steering",
        type: "steering",
        message: steering,
      }),
    ).toMatchObject({ runId, status: "applied" });
    expect(parentRequests).toHaveLength(3);
    expect(approvals).toHaveLength(1);
    expect(
      events(await new FileRunStore(storeDirectory).read(runId)).filter(
        (event) => event.type === "tool_result" && event.tool === "read" && !event.isError,
      ),
    ).toEqual([]);
    firstApproval.resolve("allow");
    const paused = await first.promise;
    expect(failures).toEqual([]);
    expect(paused.outcome, JSON.stringify(paused.outcome)).toMatchObject({
      status: "paused",
      finishReason: "tool_approval_denied",
    });
    expect(paused.snapshot.resumable).toBe(true);
    expect(await first.runtime.waitForQuiescence()).toBe(true);
    expect(parentRequests).toHaveLength(4);
    expect(childRequests).toHaveLength(0);
    expect(JSON.stringify(requests)).not.toContain(noteB);
    const pausedRecords = await new FileRunStore(storeDirectory).read(runId);
    const pausedBytes = await readFile(path.join(storeDirectory, `${runId}.jsonl`));
    const snapshot = metadata(
      pausedRecords.find((record) => record.kind === "start")!,
    ).skillSnapshot;
    expect(snapshot).toMatchObject({
      agents: {
        main: {
          standard: [
            expect.objectContaining({ id: skillId, body: skillBody, bodySha256: skillBodySha }),
          ],
        },
      },
    });
    const parentCatalog = catalogs(pausedRecords)[0]!;
    expect(parentCatalog.owner).toMatchObject({
      runId,
      agent: "main",
      executionId: expect.any(String),
    });
    const pausedRequest = providerEvents(pausedRecords).at(-1)!;
    expect(pausedRequest.toolDiscovery?.generation).toBe(1);
    await rm(skillSource);
    await expect(readFile(skillSource, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    resumedPhase = true;
    const resumed = await create(true);
    await reached(
      finalRequest.promise,
      resumed.promise,
      "冷恢复与Child完成后没有到达父Provider取消屏障",
      failures,
    );
    expect(parentRequests).toHaveLength(8);
    expect(childRequests).toHaveLength(2);
    const beforeAbort = await new FileRunStore(storeDirectory).read(runId);
    const joined = beforeAbort.find(
      (record) => record.kind === "delegation" && metadata(record).type === "parent_joined",
    );
    assert(joined, "取消之前Child必须已真实joined");
    const childRunId = metadata(joined).childRunId;
    assert(typeof childRunId === "string");
    const childRecords = await new FileRunStore(storeDirectory).read(childRunId);
    expect(ProjectionEngine.project(childRecords).outcome?.status).toBe("succeeded");
    const frozenChildBytes = await readFile(path.join(storeDirectory, `${childRunId}.jsonl`));
    controllers[1]!.abort();
    const result = await resumed.promise;
    expect(result.outcome).toMatchObject({ status: "aborted", finishReason: "aborted" });
    expect(result.snapshot.resumable).toBe(false);
    expect(await resumed.runtime.waitForQuiescence()).toBe(true);
    await vi.waitFor(() => expect(finalResponseClosed).toBe(true));
    // 先证明业务响应已取消，再正常关闭测试服务及连接池的空闲连接。
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await vi.waitFor(() => expect(sockets.size).toBe(0));
    expect(failures).toEqual([]);
    expect(requests).toHaveLength(10);
    expect(
      approvals.map((request) => [request.tool, (request.args as { path?: string }).path]),
    ).toEqual([
      ["read", "note-a.txt"],
      ["read", "note-b.txt"],
      ["read", "note-b.txt"],
      ["delegate", undefined],
    ]);
    expect(new Set(approvals.map((request) => request.approvalId)).size).toBe(4);
    const records = await new FileRunStore(storeDirectory).read(runId);
    const finalBytes = await readFile(path.join(storeDirectory, `${runId}.jsonl`));
    expect(finalBytes.subarray(0, pausedBytes.length)).toEqual(pausedBytes);
    expect(records.slice(0, pausedRecords.length)).toEqual(pausedRecords);
    expect(await readFile(path.join(storeDirectory, `${childRunId}.jsonl`))).toEqual(
      frozenChildBytes,
    );
    expect(metadata(records.find((record) => record.kind === "start")!).skillSnapshot).toEqual(
      snapshot,
    );
    expect(catalogs(records)).toEqual([parentCatalog]);
    const resumedRequest = providerEvents(records)[4]!;
    expect(resumedRequest.toolDiscovery).toEqual(pausedRequest.toolDiscovery);
    const loads = records.filter((record) => metadata(record).skillLoad !== undefined);
    expect(loads).toHaveLength(2);
    expect(loads.map((record) => metadata(record).skillLoad)).toEqual([
      expect.objectContaining({ id: skillId, bodySha256: skillBodySha, delivery: "body" }),
      expect.objectContaining({ id: skillId, bodySha256: skillBodySha, delivery: "body" }),
    ]);
    const controlFacts = records.filter(
      (record) =>
        record.kind === "control" && metadata(record).controlId === "composition-steering",
    );
    expect(controlFacts.map((record) => metadata(record).state)).toEqual(["accepted", "applied"]);
    const input = events(records).find(
      (event) =>
        event.type === "input_receipt" &&
        event.contentFingerprint === sha256(steering).slice(0, 16),
    );
    assert(input?.type === "input_receipt");
    // 原活动最终被取消；已认领输入按既有合同收尾为 discarded，不伪称成功完成。
    expect(
      events(records)
        .filter((event) => "inputId" in event && event.inputId === input.inputId)
        .map((event) => event.type),
    ).toEqual(["input_receipt", "input_claimed", "input_discarded"]);
    const childCatalog = catalogs(childRecords)[0]!;
    expect(childCatalog.owner).toMatchObject({ runId: childRunId, agent: "researcher" });
    expect(childCatalog.owner.executionId).not.toBe(parentCatalog.owner.executionId);
    expect(childCatalog.entries.map((entry) => entry.name)).toEqual(["write"]);
    const childEvents = events(childRecords);
    expect(
      childEvents.filter(
        (event) => event.type === "tool_result" && event.tool === "read" && !event.isError,
      ),
    ).toEqual([]);
    expect(
      childEvents
        .filter((event) => event.type === "effect_receipt" && event.callId === "child-guessed-read")
        .map((event) => (event.type === "effect_receipt" ? event.status : undefined)),
    ).toEqual(["not_started"]);
    expect(childEvents.filter((event) => event.type === "approval_required")).toEqual([]);
    const delegation = records.find(
      (record) => record.kind === "delegation" && metadata(record).type === "delegation_recorded",
    )!;
    expect(metadata(delegation)).toMatchObject({
      agentName: "researcher",
      childRunId,
      requestedAllocation: childBudget,
      requestedPermissions: { mode: "ask", workspaceOnly: true, network: "deny" },
    });
    const projection = ProjectionEngine.project(records);
    expect(projection.outcome).toEqual(result.outcome);
    expect(projection.snapshot).toEqual(result.snapshot);
    expect(projection.trace).toEqual(result.trace);
    expect(result.childRuns?.nodes).toMatchObject([
      { childRunId, status: "joined", outcome: { status: "succeeded" } },
    ]);
    expect(result.metrics.tokens).toBeGreaterThan(0);
    expect(result.metrics.tokens).toBeLessThanOrEqual(config.runtime!.maxTokens!);
    expect(result.metrics.toolCalls).toBeLessThanOrEqual(config.runtime!.maxToolCalls!);
    expect(config).toEqual(originalConfig);
    for (const [file, expected] of [
      ["note-a.txt", noteA],
      ["note-b.txt", noteB],
      [".env", `COMPOSITION_SECRET=${credentialCanary}\n`],
    ])
      expect(await readFile(path.join(directory, file!), "utf8")).toBe(expected);
    expect(JSON.stringify({ requests, live, projection, childRecords })).not.toContain(
      credentialCanary,
    );
    expect(JSON.stringify(childRequests)).not.toContain(skillBodySha);
    assertDeclarations(records, parentRequests);
    assertDeclarations(childRecords, childRequests);
    const requestIds = [...providerEvents(records), ...providerEvents(childRecords)].map(
      (event) => event.requestId,
    );
    expect(new Set(requestIds).size).toBe(10);
    expect(() =>
      prepareRunResume(records, fingerprintRunConfig(config), initialPrompt),
    ).toThrowError(expect.objectContaining({ code: "run_already_finished" }));
    expect(requests).toHaveLength(10);
    verified = true;
  } finally {
    for (const controller of controllers) controller.abort();
    firstApproval.resolve("deny");
    server.closeAllConnections();
    await Promise.allSettled(running);
    await Promise.all(runtimes.map((runtime) => runtime.waitForQuiescence()));
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    commitSpy.mockRestore();
    const resolved = ownedTemporaryDirectory(directory);
    if (verified)
      await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    else {
      await writeFile(
        path.join(directory, "captured-requests.json"),
        JSON.stringify(requests),
        "utf8",
      );
      await writeFile(
        path.join(directory, "captured-errors.json"),
        JSON.stringify(failures.map((error) => String(error).slice(0, 4096))),
        "utf8",
      );
      console.error(`组合验收失败证据：${directory}`);
    }
  }
}, 45_000);

function metadata(record: RunStateRecord): Record<string, unknown> {
  return record.payload as Record<string, unknown>;
}
function events(records: RunStateRecord[]): CoreMindEvent[] {
  return records.flatMap((record) =>
    record.kind === "event" ? [metadata(record).event as CoreMindEvent] : [],
  );
}
function providerEvents(records: RunStateRecord[]): ProviderRequest[] {
  return events(records).filter(
    (event): event is ProviderRequest => event.type === "provider_request",
  );
}
function catalogs(records: RunStateRecord[]): Catalog[] {
  return records.flatMap((record) =>
    metadata(record).toolDiscoveryCatalog ? [metadata(record).toolDiscoveryCatalog as Catalog] : [],
  );
}
function names(request: WireRequest): string[] {
  return request.tools?.map((tool) => tool.function.name) ?? [];
}
function textOf(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? "").join("")
      : "";
}
function toolText(request: WireRequest): string {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => textOf(message.content))
    .join("\n");
}
function userTexts(request: WireRequest): string[] {
  return request.messages
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content));
}
function searchResult(request: WireRequest): unknown {
  const value = request.messages
    .filter((message) => message.role === "tool" && textOf(message.content).includes('"matches"'))
    .at(-1);
  assert(value, "缺少真实发现结果");
  return JSON.parse(textOf(value.content));
}
function declaration(value: Declaration): Declaration {
  return { name: value.name, description: value.description, parameters: value.parameters };
}
function assertDeclarations(records: RunStateRecord[], requests: WireRequest[]) {
  const facts = records.filter(
    (record) =>
      record.kind === "event" &&
      (metadata(record).event as CoreMindEvent).type === "provider_request",
  );
  expect(facts).toHaveLength(requests.length);
  const meta = requests[0]!.tools!.find(
    (tool) => tool.function.name === "discover_tools",
  )!.function;
  for (const [index, record] of facts.entries()) {
    const event = metadata(record).event as ProviderRequest;
    assert(event.toolDiscovery, "实际请求必须带原公开声明摘要");
    const watermark = records.filter((item) => item.sequence <= record.sequence);
    const catalog = catalogs(watermark).find(
      (item) => item.fingerprint === event.toolDiscovery!.catalogFingerprint,
    );
    assert(catalog, "请求之前必须已有原目录快照");
    const selection = watermark
      .flatMap((item) =>
        metadata(item).toolDiscoverySelection
          ? [metadata(item).toolDiscoverySelection as Selection]
          : [],
      )
      .find((item) => item.fingerprint === event.toolDiscovery!.selectionFingerprint);
    assert(selection, "请求之前必须已有原持久声明代次");
    expect(selection.catalogFingerprint).toBe(catalog.fingerprint);
    expect(selection.generation).toBe(event.toolDiscovery.generation);
    const schemas = selection.names
      .map((name) => {
        const entry = catalog.entries.find((item) => item.name === name);
        assert(entry, "声明名称必须属于本执行目录");
        return structuredClone(entry.declaration);
      })
      .concat(declaration(meta));
    const wire = requests[index]!;
    expect(wire.tools!.map((tool) => declaration(tool.function))).toEqual(schemas.map(declaration));
    expect(event.toolDiscovery.toolCount).toBe(schemas.length);
    const budget = events(watermark)
      .filter((item) => item.type === "context_budget_resolved")
      .at(-1);
    assert(budget?.type === "context_budget_resolved", "请求之前必须完成真实预算");
    expect(budget).toMatchObject({
      providerId: event.providerId,
      modelId: event.modelId,
      capabilityFingerprint: event.capabilityFingerprint,
      effectiveContextWindow: 16_384,
      reservedOutputTokens: 256,
      estimator: "pi-agent-core-estimate-v1",
    });
    expect(budget.toolSchemaTokens).toBeGreaterThan(0);
    expect(budget.availableInputTokens).toBe(
      budget.effectiveContextWindow -
        budget.reservedOutputTokens -
        budget.stablePrefixTokens -
        budget.toolSchemaTokens -
        budget.structuredOutputTokens -
        budget.multimodalTokens -
        budget.protocolOverheadTokens -
        budget.safetyMarginTokens,
    );
    expect(budget.messageTokens).toBeLessThanOrEqual(budget.availableInputTokens);
    const systems = wire.messages.filter((message) => message.role === "system");
    expect(systems).toHaveLength(1);
    // 此处只核完整 schema 和稳定前缀；不将 wire 正文伪装为原生 Working Set 重放。
    const fingerprints = createProviderRequestReplayFact({
      requestId: event.requestId,
      providerId: event.providerId,
      modelId: event.modelId,
      capabilityFingerprint: event.capabilityFingerprint,
      messages: wire.messages.slice(1),
      stablePrefix: textOf(systems[0]!.content),
      toolSchemas: schemas,
    });
    expect(fingerprints.toolSchemaFingerprint).toBe(event.toolSchemaFingerprint);
    expect(fingerprints.stablePrefixFingerprint).toBe(event.stablePrefixFingerprint);
  }
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function reached<T>(
  gate: Promise<T>,
  running: Promise<Result>,
  label: string,
  failures: readonly unknown[],
): Promise<T> {
  return Promise.race([
    gate,
    running.then(
      (result) => {
        if (failures.length > 0) throw failures[0];
        throw new Error(`${label}：${JSON.stringify(result.outcome)}`);
      },
      (error: unknown) => {
        if (failures.length > 0) throw failures[0];
        throw error;
      },
    ),
  ]);
}
function ownedTemporaryDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  assert(
    path.dirname(resolved) === path.resolve(tmpdir()) &&
      path.basename(resolved).startsWith("coremind-release-composition-"),
  );
  return resolved;
}
function sendCalls(response: ServerResponse, calls: Call[]) {
  send(
    response,
    {
      role: "assistant",
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    },
    "tool_calls",
  );
}
function sendText(response: ServerResponse, content: string) {
  send(response, { role: "assistant", content }, "stop");
}
function send(response: ServerResponse, delta: unknown, finish: string) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.write(
    `data: ${JSON.stringify({ id: "release-composition", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "release-composition",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 120, completion_tokens: 16, total_tokens: 136 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

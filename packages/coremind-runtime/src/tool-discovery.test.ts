import type { ToolEffectDeclaration } from "coremind-config";
import { resolveToolCapability } from "coremind-tools";
import { expect, it } from "vitest";
import type { AgentDriverToolResult } from "./agent-driver.js";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import type { FactDurabilityReceipt } from "./fact-ledger.js";
import type { RunStateRecord } from "./run-state.js";
import {
  DISCOVER_TOOLS_NAME,
  restoreToolDiscovery,
  type ToolDiscoveryEntry,
  ToolDiscoveryExecution,
  type ToolDiscoveryPrepared,
  type ToolDiscoverySearchFact,
} from "./tool-discovery.js";

const owner = { runId: "run-discovery", agent: "main", stepId: "step-1" };

it("真正调用本地目录支持中文和英文查询，稳定同分排序且不提前返回参数 schema", () => {
  const discovery = create();
  for (const query of ["订单", "ＯＲＤＥＲ"]) {
    const result = discovery.search(`query-${query}`, { query });
    expect(result.details).toMatchObject({ matches: [{ name: "orders_read" }], truncated: false });
    expect(JSON.stringify(result)).not.toContain("private-parameter-canary");
  }
  const ranked = create([
    entry("z_read", "读取记录 read records"),
    entry("a_read", "读取记录 read records"),
  ]);
  const first = ranked.search("rank-1", { query: "read" });
  const second = ranked.search("rank-2", { query: "read" });
  expect(first).toEqual(second);
  expect(first.details).toMatchObject({ matches: [{ name: "a_read" }, { name: "z_read" }] });
});

it("只搜索当前目录，初始未声明工具的猜名调用仍被拒绝", () => {
  const discovery = create();
  expect(discovery.search("other", { query: "other-agent-secret" }).details).toEqual({
    matches: [],
    truncated: false,
  });
  expect(() => discovery.assertCallable("orders_read")).toThrowError(
    expect.objectContaining({ code: "invalid_tool" }),
  );
  expect(() => discovery.assertCallable("other-agent-secret")).toThrowError(
    expect.objectContaining({ code: "invalid_tool" }),
  );
  expect(discovery.current).toBeUndefined();
});

it("匹配真实成功 observation 才返回旁挂 fact，错误结果不能激活", () => {
  const discovery = create();
  const args = { query: "订单" };
  const result = discovery.search("success", args);
  const fact = discovery.observe({
    type: "tool_execution_end",
    call: { callId: "success", tool: DISCOVER_TOOLS_NAME, args },
    result,
    isError: false,
  });
  expect(fact).toMatchObject({
    version: 1,
    owner,
    callId: "success",
    catalogFingerprint: discovery.catalog.fingerprint,
  });
  expect(fact?.entries).toHaveLength(1);
  const failed = discovery.search("failed", args);
  expect(
    discovery.observe({
      type: "tool_execution_end",
      call: { callId: "failed", tool: DISCOVER_TOOLS_NAME, args },
      result: failed,
      isError: true,
    }),
  ).toBeUndefined();
  const changed = discovery.search("changed", args);
  expect(
    discovery.observe({
      type: "tool_execution_end",
      call: { callId: "changed", tool: DISCOVER_TOOLS_NAME, args },
      result: { ...changed, details: {} },
      isError: false,
    }),
  ).toBeUndefined();
  expect(discovery.current).toBeUndefined();
});

it("prepare 不发布声明，只有同 eventId 的真正 critical receipt 才能 commit", () => {
  const discovery = create();
  const initial = prepare(discovery);
  expect(initial.catalog).toEqual(discovery.catalog);
  expect(initial.selection).toMatchObject({
    generation: 0,
    names: ["direct_read"],
    withdrawnSources: [],
  });
  expect(() =>
    discovery.commit(initial, { ...receipt(initial), eventId: "another-event" }),
  ).toThrow();
  expect(() => discovery.commit(initial, receipt(initial, "ordinary"))).toThrow();
  expect(discovery.current).toBeUndefined();
  discovery.commit(initial, receipt(initial));
  expect(discovery.current).toEqual(initial.selection);
  expect(discovery.assertCallable("direct_read")).toMatchObject({ owner, name: "direct_read" });
  expect(() => discovery.assertCallable("orders_read")).toThrow();
});

it("搜索成功仍不解锁同批次，下一安全边界安装且重复结果幂等", () => {
  const discovery = create();
  const initial = prepare(discovery);
  discovery.commit(initial, receipt(initial));
  const fact = successfulSearch(discovery, "search-1", { query: "订单" });
  expect(() => discovery.assertCallable("orders_read")).toThrow();
  const installed = prepare(discovery, [fact]);
  expect(installed.catalog).toBeUndefined();
  expect(installed.selection).toMatchObject({
    generation: 1,
    names: ["direct_read", "orders_read"],
    previousFingerprint: initial.selection.fingerprint,
  });
  expect(() => discovery.assertCallable("orders_read")).toThrow();
  discovery.commit(installed, receipt(installed));
  expect(discovery.assertCallable("orders_read")).toMatchObject({
    name: "orders_read",
    sourceIdentity: "orders-source",
  });
  expect(discovery.prepare([fact])).toBeUndefined();
});

it("来源撤回先阻断旧调用和候选，失效前 prepare 的帧不能迟到发布", () => {
  const discovery = create();
  const initial = prepare(discovery);
  discovery.commit(initial, receipt(initial));
  const fact = successfulSearch(discovery, "search-1", { query: "订单" });
  const pending = prepare(discovery, [fact]);
  discovery.withdraw("orders-source");
  expect(() => discovery.commit(pending, receipt(pending))).toThrowError(
    expect.objectContaining({ code: "tool_capability_conflict" }),
  );
  expect(discovery.search("after-withdraw", { query: "订单" }).details).toEqual({
    matches: [],
    truncated: false,
  });
  expect(() => discovery.assertCallable("orders_read")).toThrow();
  const removed = prepare(discovery, [fact]);
  expect(removed.selection.withdrawnSources).toEqual(["orders-source"]);
  expect(removed.selection.names).toEqual(["direct_read"]);
});

it.each([
  { query: " " },
  { query: "x".repeat(257) },
  { query: "订单", limit: 0 },
  { query: "订单", limit: 9 },
  { query: "订单", limit: 1.5 },
  { query: "订单", limit: null },
  { query: "订单", extra: true },
])("发现入口严格拒绝非法查询和上限：%j", (args) => {
  expect(() => create().search("invalid", args)).toThrowError(
    expect.objectContaining({ code: "invalid_tool" }),
  );
});

it("中文大描述的公开结果同时满足数量和 UTF-8 字节上限", () => {
  const discovery = create(
    Array.from({ length: 8 }, (_, index) => entry(`read_${index}`, "读取记录".repeat(2000))),
  );
  const result = discovery.search("large", { query: "读取", limit: 8 });
  const details = result.details as { matches: unknown[]; truncated: boolean };
  expect(details.matches.length).toBeGreaterThan(0);
  expect(details.matches.length).toBeLessThanOrEqual(8);
  expect(details.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16 * 1024);
});

it("纯 fold 恢复原目录与轻量 generation，不接受缺快照的激活事实", () => {
  const discovery = create();
  const initial = prepare(discovery);
  discovery.commit(initial, receipt(initial));
  const fact = successfulSearch(discovery, "search-1", { query: "订单" });
  const installed = prepare(discovery, [fact]);
  discovery.commit(installed, receipt(installed));
  const records: RunStateRecord[] = [
    record(1, { toolDiscoveryCatalog: initial.catalog, toolDiscoverySelection: initial.selection }),
    record(2, {
      event: {
        type: "tool_result",
        agent: owner.agent,
        stepId: owner.stepId,
        callId: fact.callId,
        tool: DISCOVER_TOOLS_NAME,
        isError: false,
      },
      toolDiscoverySearch: fact,
    }),
    record(3, { toolDiscoverySelection: installed.selection }),
  ];
  const restored = restoreToolDiscovery(records, owner);
  expect(restored?.catalog).toEqual(discovery.catalog);
  expect(restored?.selections).toEqual([initial.selection, installed.selection]);
  const next = new ToolDiscoveryExecution({ owner, entries: discovery.catalog.entries, restored });
  expect(next.current).toEqual(installed.selection);
  expect(next.assertCallable("orders_read")).toMatchObject({ name: "orders_read" });
  expect(() => restoreToolDiscovery(records.slice(1), owner)).toThrow();
});

it("目录独立深冻结，输入和返回值不能改写原 schema 或曝光范围", () => {
  const selected = entry("orders_read", "查询订单 read order");
  const discovery = create([selected]);
  (selected.declaration.parameters as Record<string, unknown>).additionalProperties = true;
  expect(
    (discovery.catalog.entries[0]!.declaration.parameters as Record<string, unknown>)
      .additionalProperties,
  ).toBe(false);
  expect(Object.isFrozen(discovery.catalog)).toBe(true);
  expect(Object.isFrozen(discovery.catalog.entries)).toBe(true);
  expect(Object.isFrozen(discovery.catalog.entries[0]!.declaration.parameters)).toBe(true);
  const plan = prepare(discovery);
  expect(Object.isFrozen(plan.selection.names)).toBe(true);
  expect(() => (plan.selection.names as string[]).push("other-agent-secret")).toThrow();
});

it("显式发现模式的目录条数和 canonical schema 总字节有硬上限", () => {
  expect(() =>
    create(Array.from({ length: 257 }, (_, index) => entry(`tool_${index}`, "读取"))),
  ).toThrow();
  const large = entry("large", "读取");
  (large.declaration.parameters as Record<string, unknown>).description = "x".repeat(
    8 * 1024 * 1024,
  );
  expect(() => create([large])).toThrow();
  expect(() => create([entry("same", "读取"), entry("same", "读取")])).toThrow();
  expect(() => create([entry(DISCOVER_TOOLS_NAME, "不能搜索自身")])).toThrow();
});

it("撤回未激活来源仍提交 generation，恢复后搜索和调用都不能回生", () => {
  const discovery = create();
  const initial = prepare(discovery);
  discovery.commit(initial, receipt(initial));
  discovery.withdraw("orders-source");
  const removed = prepare(discovery);
  expect(removed.selection).toMatchObject({
    generation: 1,
    names: ["direct_read"],
    withdrawnSources: ["orders-source"],
  });
  discovery.commit(removed, receipt(removed));
  expect(discovery.prepare([])).toBeUndefined();
  const restored = restoreToolDiscovery(
    [
      record(1, {
        toolDiscoveryCatalog: initial.catalog,
        toolDiscoverySelection: initial.selection,
      }),
      record(2, { toolDiscoverySelection: removed.selection }),
    ],
    owner,
  )!;
  const next = new ToolDiscoveryExecution({ owner, entries: discovery.catalog.entries, restored });
  expect(next.search("after-resume", { query: "订单" }).details).toEqual({
    matches: [],
    truncated: false,
  });
  expect(() => next.assertCallable("orders_read")).toThrow();
});

it("无关激活不使合法旧绑定失效，撤回原来源则立即失效", () => {
  const discovery = create();
  const initial = prepare(discovery);
  discovery.commit(initial, receipt(initial));
  const binding = discovery.assertCallable("direct_read");
  const install = prepare(discovery, [successfulSearch(discovery, "search", { query: "订单" })]);
  discovery.commit(install, receipt(install));
  expect(discovery.assertCallable("direct_read", binding)).toEqual(binding);
  discovery.withdraw("direct_read");
  expect(() => discovery.assertCallable("direct_read", binding)).toThrowError(
    expect.objectContaining({ code: "tool_capability_conflict" }),
  );
});

it.each(["hash", "generation", "names"])(
  "restore 拒绝篡改的 %s，不能仅靠重算哈希激活未知工具",
  (mode) => {
    const discovery = create();
    const initial = prepare(discovery);
    const changed = structuredClone(initial.selection) as unknown as Record<string, unknown>;
    if (mode === "hash") changed.fingerprint = "0".repeat(64);
    if (mode === "generation") changed.generation = 2;
    if (mode === "names") {
      changed.names = ["direct_read", "other-agent-secret"];
      const { fingerprint: _old, ...body } = changed;
      changed.fingerprint = fingerprintEffectReceiptValue(body);
    }
    expect(() =>
      restoreToolDiscovery(
        [record(1, { toolDiscoveryCatalog: initial.catalog, toolDiscoverySelection: changed })],
        owner,
      ),
    ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
  },
);

it("新 Run 不从其他 owner 事实恢复激活；同 Run 真实 schema 漂移明确拒绝", () => {
  const discovery = create();
  const initial = prepare(discovery);
  const restored = restoreToolDiscovery(
    [
      record(1, {
        toolDiscoveryCatalog: initial.catalog,
        toolDiscoverySelection: initial.selection,
      }),
    ],
    owner,
  )!;
  expect(
    restoreToolDiscovery(
      [
        record(1, {
          toolDiscoveryCatalog: initial.catalog,
          toolDiscoverySelection: initial.selection,
        }),
      ],
      { ...owner, agent: "another-agent" },
    ),
  ).toBeUndefined();
  const changed = entry("orders_read", "已变化的查询 schema");
  expect(
    () =>
      new ToolDiscoveryExecution({
        owner,
        entries: [entry("direct_read", "直接读取", "direct"), changed],
        restored,
      }),
  ).toThrowError(expect.objectContaining({ code: "tool_capability_conflict" }));
});

function entry(
  name: string,
  description: string,
  exposure: "direct" | "deferred" = "deferred",
): ToolDiscoveryEntry {
  const effect: ToolEffectDeclaration = { operations: ["read"], reversible: true };
  return {
    name,
    description,
    exposure,
    sourceIdentity: name === "orders_read" ? "orders-source" : name,
    declaration: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { "private-parameter-canary": { type: "string" } },
        additionalProperties: false,
      },
      constrainedSampling: { type: "json_schema", strict: "prefer" },
    },
    effect,
    capability: resolveToolCapability({
      tool: name,
      source: "registered",
      declaration: {
        effect: "none",
        replay: "safe",
        concurrency: "parallel",
        checkpoint: "none",
        durability: "ordinary",
      },
    }),
  };
}

function create(
  entries = [
    entry("direct_read", "直接读取", "direct"),
    entry("orders_read", "查询订单 read order records"),
  ],
) {
  return new ToolDiscoveryExecution({ owner, entries });
}

function prepare(
  discovery: ToolDiscoveryExecution,
  facts: readonly ToolDiscoverySearchFact[] = [],
) {
  const prepared = discovery.prepare(facts);
  expect(prepared).toBeDefined();
  return prepared!;
}

function successfulSearch(discovery: ToolDiscoveryExecution, callId: string, args: unknown) {
  const result: AgentDriverToolResult = discovery.search(callId, args);
  const fact = discovery.observe({
    type: "tool_execution_end",
    call: { callId, tool: DISCOVER_TOOLS_NAME, args },
    result,
    isError: false,
  });
  expect(fact).toBeDefined();
  return fact!;
}

function receipt(
  prepared: ToolDiscoveryPrepared,
  durability: "ordinary" | "critical" = "critical",
): FactDurabilityReceipt {
  return {
    runId: owner.runId,
    sequence: prepared.selection.generation + 1,
    eventId: prepared.eventId,
    kind: "event",
    durability,
    acknowledgement: { requested: durability, achieved: durability, boundary: "process_crash" },
    latencyMs: 0,
    acknowledgedAt: new Date(0).toISOString(),
  };
}

function record(sequence: number, payload: unknown): RunStateRecord {
  return {
    version: 1,
    runId: owner.runId,
    sequence,
    timestamp: new Date(0).toISOString(),
    kind: "event",
    payload,
  };
}

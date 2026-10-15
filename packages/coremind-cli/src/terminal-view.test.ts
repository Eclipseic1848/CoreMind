import type { CoreMindEvent } from "coremind-ai";
import { describe, expect, it } from "vitest";
import { formatTerminalRow } from "./render.js";
import {
  createTerminalView,
  foldTerminalView,
  MAX_TERMINAL_ROWS,
  type TerminalRow,
  type TerminalViewState,
} from "./terminal-view.js";

const call = (callId: string, agent = "main", stepId = "step"): CoreMindEvent => ({
  type: "tool_call",
  agent,
  stepId,
  callId,
  tool: "read",
  args: { path: "same.txt" },
});
function event(state: TerminalViewState, value: CoreMindEvent, epoch = 1): TerminalViewState {
  return foldTerminalView(state, { type: "event", epoch, event: value, observedAtMs: 10 });
}
function sourcedEvent(
  state: TerminalViewState,
  value: CoreMindEvent,
  runId: string,
): TerminalViewState {
  const action = { type: "event" as const, epoch: 1, event: value, observedAtMs: 10, runId };
  return foldTerminalView(state, action);
}
function start() {
  return foldTerminalView(createTerminalView(), { type: "begin", epoch: 1 });
}
function tools(state: TerminalViewState) {
  return state.rows.filter(
    (row): row is Extract<TerminalRow, { kind: "tool" }> => row.kind === "tool",
  );
}

describe("有界终端工具视图", () => {
  it("同名同参并行调用反序完成，时长/结果按完整身份绑定", () => {
    let state = event(event(event(start(), call("a")), call("b")), call("a", "worker", "step"));
    state = event(state, {
      type: "tool_execution_evidence",
      agent: "main",
      stepId: "step",
      callId: "b",
      tool: "read",
      execution: { durationMs: 72, exitCode: null },
    });
    state = event(state, {
      type: "tool_result",
      agent: "main",
      stepId: "step",
      callId: "b",
      tool: "read",
      isError: true,
    });
    state = event(state, {
      type: "tool_execution_evidence",
      agent: "main",
      stepId: "step",
      callId: "a",
      tool: "read",
      execution: { durationMs: 9, exitCode: 0 },
    });
    state = event(state, {
      type: "tool_result",
      agent: "main",
      stepId: "step",
      callId: "a",
      tool: "read",
      isError: false,
    });
    expect(tools(state)).toHaveLength(3);
    expect(
      tools(state).find((row) => row.call.agent === "main" && row.call.callId === "a"),
    ).toMatchObject({ isError: false, execution: { durationMs: 9 } });
    expect(tools(state).find((row) => row.call.callId === "b")).toMatchObject({
      isError: true,
      execution: { durationMs: 72 },
    });
    expect(tools(state).find((row) => row.call.agent === "worker")).toMatchObject({
      resultReceived: false,
    });
  });

  it("缺 callId 的旧结果独立显示，不能按工具名完成并行行", () => {
    let state = event(event(start(), call("a")), call("b"));
    state = event(state, { type: "tool_result", agent: "main", tool: "read", isError: false });
    expect(tools(state)).toHaveLength(2);
    expect(tools(state).every((row) => !row.resultReceived)).toBe(true);
    expect(state.rows.map((row) => formatTerminalRow(row)).join("\n")).toContain("未绑定");
  });

  it("执行中止、效果未知、持久状态与真实耗时互不覆盖", () => {
    let state = event(start(), call("a"));
    state = event(state, {
      type: "tool_lifecycle",
      agent: "main",
      stepId: "step",
      callId: "a",
      tool: "read",
      resolution: {
        phase: "observed",
        status: "completed",
        result: { executionOutcome: "aborted", effectState: "unknown", cleanupState: "pending" },
      },
    });
    state = event(state, {
      type: "effect_receipt",
      agent: "main",
      stepId: "step",
      callId: "a",
      tool: "read",
      idempotencyKey: "receipt-a",
      status: "unknown",
    });
    state = event(state, {
      type: "tool_execution_evidence",
      agent: "main",
      stepId: "step",
      callId: "a",
      tool: "read",
      execution: { durationMs: 160, exitCode: null },
    });
    state = event(state, {
      type: "tool_result",
      agent: "main",
      stepId: "step",
      callId: "a",
      tool: "read",
      isError: false,
    });
    state = event(state, {
      type: "tool_lifecycle",
      agent: "main",
      stepId: "step",
      callId: "a",
      tool: "read",
      resolution: {
        phase: "result_durable",
        status: "failed",
        reason: "持久确认失败",
        result: { persistenceState: "failed" },
      },
    });
    const row = tools(state)[0]!;
    expect(row).toMatchObject({
      result: { executionOutcome: "aborted", effectState: "unknown", persistenceState: "failed" },
      effect: "unknown",
      execution: { durationMs: 160 },
    });
    const display = formatTerminalRow(row);
    expect(display).toContain("中止");
    expect(display).toContain("未知");
    expect(display).toContain("160");
  });

  it("Run 结束只有真实引用，不会把未收到结果变成完成或取消", () => {
    const state = foldTerminalView(sourcedEvent(start(), call("a"), "run-real"), {
      type: "end",
      epoch: 1,
      runId: "run-real",
    });
    const row = tools(state)[0]!;
    expect(row).toMatchObject({ runId: "run-real", runEnded: true, resultReceived: false });
    expect(row.execution).toBeUndefined();
    expect(formatTerminalRow(row)).toContain("未收到结果");
    expect(formatTerminalRow(row)).toContain("未记录");
  });

  it("catch没有RunResult也能结束观察，不捏造RunId", () => {
    const state = foldTerminalView(event(start(), call("a")), { type: "end", epoch: 1 });
    const row = tools(state)[0]!;
    expect(row.runId).toBeUndefined();
    expect(row.runEnded).toBe(true);
    expect(formatTerminalRow(row)).toContain("未收到结果");
  });

  it("已裁掉的调用收到迟到证据时独立提示，所有活动行和索引仍至多30", () => {
    let state = start();
    for (let index = 0; index < 100; index++) state = event(state, call(`call-${index}`));
    expect(state.rows).toHaveLength(MAX_TERMINAL_ROWS);
    expect(tools(state)).toHaveLength(MAX_TERMINAL_ROWS);
    state = event(state, {
      type: "tool_execution_evidence",
      agent: "main",
      stepId: "step",
      callId: "call-0",
      tool: "read",
      execution: { durationMs: 23, exitCode: null },
    });
    expect(state.rows).toHaveLength(MAX_TERMINAL_ROWS);
    expect(tools(state).find((row) => row.call.callId === "call-0")).toMatchObject({
      detached: true,
      execution: { durationMs: 23 },
    });
    expect(Object.keys(state).sort()).toEqual(["active", "nextId", "rows"]);
  });

  it("不同 Run 的同 callId 不回配，迟到旧 epoch 不污染新行", () => {
    let state = event(start(), call("same"));
    state = foldTerminalView(state, { type: "end", epoch: 1, runId: "old-run" });
    state = foldTerminalView(state, { type: "begin", epoch: 2 });
    state = event(state, call("same"), 2);
    state = event(
      state,
      {
        type: "tool_result",
        agent: "main",
        stepId: "step",
        callId: "same",
        tool: "read",
        isError: true,
      },
      1,
    );
    expect(tools(state).find((row) => row.epoch === 2)).toMatchObject({ resultReceived: false });
  });

  it("不保存 rawargs/结果正文，摘要保持 false/0/null且不含秘密", () => {
    const state = event(start(), {
      ...call("safe"),
      args: {
        apiKey: "canary-secret-value",
        content: "不应保存的正文",
        enabled: false,
        count: 0,
        value: null,
      },
    } as Extract<CoreMindEvent, { type: "tool_call" }>);
    const row = tools(state)[0]!;
    expect(row.arguments).toContain("false");
    expect(row.arguments).toContain("0");
    expect(row.arguments).toContain("null");
    expect(JSON.stringify(state)).not.toContain("canary-secret-value");
    expect(JSON.stringify(state)).not.toContain("不应保存的正文");
    expect(row).not.toHaveProperty("args");
  });

  it("大于4KiB的原始身份不截断后匹配，只显示未绑定摘要", () => {
    const huge = "identity-".repeat(700);
    const state = event(start(), call(huge));
    expect(tools(state)).toHaveLength(0);
    expect(JSON.stringify(state)).not.toContain(huge);
    expect(state.rows.map((row) => formatTerminalRow(row)).join("\n")).toContain("未绑定");
  });

  it("身份中的换行或空白不净化后回配，无效Run来源仍明确未绑定", () => {
    for (const value of [
      call("call\nforged"),
      call("call", "worker\tforged"),
      call("call", "worker", "step forged"),
    ]) {
      const state = sourcedEvent(start(), value, "run-real");
      expect(tools(state)).toHaveLength(0);
      expect(state.rows.map((row) => formatTerminalRow(row)).join("\n")).toContain("未绑定");
    }
    const state = sourcedEvent(start(), call("call"), "run\nforged");
    expect(tools(state)[0]?.runId).toBeUndefined();
    expect(formatTerminalRow(tools(state)[0]!)).toContain("Run 未绑定");
  });

  it.each([
    { label: "Tab净化", first: "前\t…", safeFirst: "前 …" },
    { label: "凭据脱敏", first: "token=markerSECRET …", safeFirst: "token=hidden …" },
  ])("$label后的合法省略号不丢失工具续轮正文", ({ first, safeFirst }) => {
    let state = event(start(), { type: "agent_start", agent: "main", stepId: "step" });
    state = event(state, { type: "text_delta", agent: "main", stepId: "step", delta: first });
    state = event(state, call("between-turns"));
    state = event(state, {
      type: "tool_result",
      agent: "main",
      stepId: "step",
      callId: "between-turns",
      tool: "read",
      isError: false,
    });
    state = event(state, {
      type: "text_delta",
      agent: "main",
      stepId: "step",
      delta: "后续最终正文",
    });
    expect(state.rows.filter((row) => row.kind === "text" && row.role === "assistant")).toEqual([
      expect.objectContaining({ text: `${safeFirst}后续最终正文`, truncated: false }),
    ]);
    expect(JSON.stringify(state)).not.toContain("markerSECRET");
  });

  it("中文组合 emoji 长流与大量通知不会令记录或单条字符串无界", () => {
    let state = event(start(), { type: "agent_start", agent: "main" });
    for (let index = 0; index < 20; index++)
      state = event(state, { type: "text_delta", agent: "main", delta: "中👩‍👩‍👧‍👦".repeat(1000) });
    const text = state.rows.find((row) => row.kind === "text" && row.role === "assistant");
    expect(text?.kind).toBe("text");
    if (!text || text.kind !== "text") throw new Error("缺少实际文本行");
    expect(
      Array.from(new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(text.text)).length,
    ).toBeLessThanOrEqual(16_384);
    expect(Buffer.byteLength(text.text, "utf8")).toBeLessThanOrEqual(65_536);
    expect(text.text).toContain("…");
    expect(text.truncated).toBe(true);
    state = event(state, { type: "text_delta", agent: "main", delta: "超限后不得追加" });
    expect(state.rows.find((row) => row.kind === "text" && row.role === "assistant")).toMatchObject(
      {
        text: text.text,
        truncated: true,
      },
    );
    for (let index = 0; index < 100; index++)
      state = foldTerminalView(state, {
        type: "append",
        epoch: 1,
        role: "notice",
        text: `通知${index}`,
      });
    expect(state.rows).toHaveLength(30);
  });
});

describe("审批与来源身份", () => {
  const required = (approvalId: string, callId?: string) => ({
    type: "approval_required" as const,
    runId: "run-1",
    approvalId,
    agent: "main",
    stepId: "step",
    ...(callId ? { callId } : {}),
    tool: "read",
    args: { path: "same.txt" },
    argumentsFingerprint: "a".repeat(64),
    risk: "low" as const,
    effect: {
      operations: ["read" as const],
      paths: ["same.txt"],
      urls: [],
      reversible: true,
      declared: true,
    },
  });

  it("并行同参审批按真实 callId 关联，resolved只按runId+approvalId回连", () => {
    let state = sourcedEvent(sourcedEvent(start(), call("a"), "run-1"), call("b"), "run-1");
    state = event(event(state, required("approval-b", "b")), required("approval-a", "a"));
    state = event(state, {
      type: "approval_resolved",
      runId: "run-1",
      approvalId: "approval-a",
      decision: "deny",
    });
    expect(tools(state).find((row) => row.call.callId === "a")?.approval).toEqual({
      approvalId: "approval-a",
      decision: "deny",
    });
    expect(tools(state).find((row) => row.call.callId === "b")?.approval).toEqual({
      approvalId: "approval-b",
    });
  });

  it("旧审批无 callId独立面板，不把同参工具行标为已批准", () => {
    let state = sourcedEvent(sourcedEvent(start(), call("a"), "run-1"), call("b"), "run-1");
    state = event(state, required("old-approval"));
    state = event(state, {
      type: "approval_resolved",
      runId: "run-1",
      approvalId: "old-approval",
      decision: "allow",
    });
    expect(tools(state)).toHaveLength(2);
    expect(tools(state).every((row) => row.approval === undefined)).toBe(true);
    expect(
      state.rows.some(
        (row) =>
          row.kind === "approval" && row.approvalId === "old-approval" && row.decision === "allow",
      ),
    ).toBe(true);
  });

  it("Artifact完整来源精确保留，旧来源缺失时不按同 callId猜关联", () => {
    let state = event(event(start(), call("same", "main")), call("same", "worker"));
    const artifact = {
      type: "artifact_created" as const,
      artifactId: "artifact-1",
      status: "stored" as const,
      sizeBytes: 12,
      mediaType: "text/plain",
      redaction: "none" as const,
      relativePath: ".coremind/artifacts/artifact-1.txt",
      tool: "read",
      callId: "same",
      agent: "worker",
      stepId: "step",
    };
    state = event(state, artifact);
    state = event(state, { ...artifact, artifactId: "legacy-artifact", agent: undefined });
    expect(
      state.rows.find((row) => row.kind === "artifact" && row.artifactId === "artifact-1"),
    ).toMatchObject({ call: { agent: "worker", stepId: "step", callId: "same" } });
    expect(
      state.rows.find((row) => row.kind === "artifact" && row.artifactId === "legacy-artifact"),
    ).not.toHaveProperty("call");
  });
});

describe("同epoch的Run来源隔离", () => {
  it("同agent/step/call的两个Run反向返回时各保留工具行、结果和耗时", () => {
    let state = start();
    for (const runId of ["run-a", "run-b"])
      state = sourcedEvent(state, call("same-call", "worker"), runId);
    for (const [runId, durationMs, isError] of [
      ["run-b", 72, false],
      ["run-a", 9, true],
    ] as const) {
      state = sourcedEvent(
        state,
        {
          type: "tool_execution_evidence",
          agent: "worker",
          stepId: "step",
          callId: "same-call",
          tool: "read",
          execution: { durationMs, exitCode: null },
        },
        runId,
      );
      state = sourcedEvent(
        state,
        {
          type: "tool_result",
          agent: "worker",
          stepId: "step",
          callId: "same-call",
          tool: "read",
          isError,
        },
        runId,
      );
    }
    state = foldTerminalView(state, { type: "end", epoch: 1, runId: "parent-run" });
    expect(tools(state)).toHaveLength(2);
    expect(tools(state)).toMatchObject([
      { runId: "run-a", isError: true, execution: { durationMs: 9 } },
      { runId: "run-b", isError: false, execution: { durationMs: 72 } },
    ]);
  });

  it("审批自身runId只关联对应Run调用，不给其他来源或无来源行补认Run", () => {
    let state = event(start(), call("without-source", "worker"));
    for (const runId of ["run-a", "run-b"])
      state = sourcedEvent(state, call("same-call", "worker"), runId);
    state = sourcedEvent(
      state,
      {
        type: "approval_required",
        runId: "run-a",
        approvalId: "approval-a",
        agent: "worker",
        stepId: "step",
        callId: "same-call",
        tool: "read",
        args: { path: "same.txt" },
        argumentsFingerprint: "a".repeat(64),
        risk: "low",
        effect: {
          operations: ["read"],
          paths: ["same.txt"],
          urls: [],
          reversible: true,
          declared: true,
        },
      },
      "run-a",
    );
    state = sourcedEvent(
      state,
      {
        type: "approval_resolved",
        runId: "run-a",
        approvalId: "approval-a",
        decision: "allow",
      },
      "run-a",
    );
    state = foldTerminalView(state, { type: "end", epoch: 1, runId: "parent-run" });
    expect(tools(state)).toHaveLength(3);
    const unbound = tools(state).find((row) => row.call.callId === "without-source")!;
    expect(unbound.runId).toBeUndefined();
    expect(formatTerminalRow(unbound)).toContain("Run 未绑定");
    expect(tools(state).find((row) => row.runId === "run-a")).toMatchObject({
      approval: { approvalId: "approval-a", decision: "allow" },
    });
    expect(tools(state).find((row) => row.runId === "run-b")?.approval).toBeUndefined();
    expect(tools(state).some((row) => row.runId === "run-b")).toBe(true);
  });

  it("同agent/step正文及同inputId回执按显式Run隔离，父Run结束不覆盖来源", () => {
    let state = start();
    const timestamp = new Date(0).toISOString();
    for (const runId of ["run-a", "run-b"]) {
      state = sourcedEvent(state, { type: "agent_start", agent: "worker", stepId: "step" }, runId);
      state = sourcedEvent(
        state,
        {
          type: "text_delta",
          agent: "worker",
          stepId: "step",
          delta: `${runId}首段`,
        },
        runId,
      );
      state = sourcedEvent(
        state,
        {
          type: "input_receipt",
          inputId: "same-input",
          status: "pending",
          contentFingerprint: "a".repeat(16),
          timestamp,
        },
        runId,
      );
    }
    state = sourcedEvent(
      state,
      {
        type: "input_claimed",
        inputId: "same-input",
        status: "claimed",
        turnId: "turn-a",
        timestamp,
      },
      "run-a",
    );
    state = sourcedEvent(
      state,
      {
        type: "input_discarded",
        inputId: "same-input",
        status: "discarded",
        timestamp,
      },
      "run-b",
    );
    for (const runId of ["run-b", "run-a"])
      state = sourcedEvent(
        state,
        {
          type: "text_delta",
          agent: "worker",
          stepId: "step",
          delta: `${runId}续段`,
        },
        runId,
      );
    state = foldTerminalView(state, { type: "end", epoch: 1, runId: "parent-run" });
    expect(
      state.rows.filter((row) => row.kind === "text" && row.role === "assistant"),
    ).toMatchObject([
      { runId: "run-a", text: "run-a首段run-a续段" },
      { runId: "run-b", text: "run-b首段run-b续段" },
    ]);
    expect(state.rows.filter((row) => row.kind === "input")).toMatchObject([
      { runId: "run-a", inputId: "same-input", status: "claimed", turnId: "turn-a" },
      { runId: "run-b", inputId: "same-input", status: "discarded" },
    ]);
  });
});

describe("控制、技能与发现提示", () => {
  it("控制五态与input消费分离，applied不变成claimed", () => {
    let state = start();
    for (const status of ["accepted", "applied", "rejected", "duplicate", "conflict"] as const) {
      state = foldTerminalView(state, {
        type: "control",
        epoch: 1,
        receipt: { schemaVersion: 1, controlId: `control-${status}`, runId: "run-1", status },
      });
    }
    state = event(state, {
      type: "input_receipt",
      inputId: "input-1",
      status: "pending",
      contentFingerprint: "a".repeat(16),
      timestamp: new Date(0).toISOString(),
    });
    expect(state.rows.filter((row) => row.kind === "control")).toHaveLength(5);
    expect(state.rows.find((row) => row.kind === "input")).toMatchObject({ status: "pending" });
    expect(
      state.rows
        .filter((row) => row.kind === "control")
        .map((row) => formatTerminalRow(row))
        .join("\n"),
    ).not.toContain("已消费");
  });

  it("context_prefix只准备，实际provider_request才本次使用，不输出私有目录", () => {
    const summary = {
      version: 1 as const,
      generation: 2,
      catalogFingerprint: "a".repeat(64),
      selectionFingerprint: "b".repeat(64),
      toolCount: 3,
    };
    let state = event(start(), {
      type: "context_prefix",
      agent: "main",
      fingerprint: "c".repeat(64),
      toolDiscovery: summary,
    });
    expect(state.rows.map((row) => formatTerminalRow(row)).join("\n")).toContain("正在准备");
    expect(state.rows.map((row) => formatTerminalRow(row)).join("\n")).not.toContain("本次使用");
    state = event(state, {
      type: "provider_request",
      agent: "main",
      requestId: "request-real",
      providerId: "fixture",
      modelId: "fixture",
      messageFingerprint: "d".repeat(64),
      stablePrefixFingerprint: "c".repeat(64),
      toolSchemaFingerprint: "e".repeat(64),
      capabilityFingerprint: "f".repeat(64),
      contextWorkingSetFingerprint: "0".repeat(64),
      toolDiscovery: summary,
    });
    expect(state.rows.map((row) => formatTerminalRow(row)).join("\n")).toContain("本次使用");
    expect(JSON.stringify(state)).not.toContain("toolDiscoveryCatalog");
  });

  it("load_skill实际成功只说明交付，不读取结果正文或增加权限", () => {
    let state = event(start(), {
      type: "tool_call",
      agent: "main",
      callId: "skill-call",
      tool: "load_skill",
      args: { id: "authorized-skill" },
    });
    expect(state.rows.map((row) => formatTerminalRow(row)).join("\n")).not.toContain("说明已交付");
    state = event(state, {
      type: "tool_result",
      agent: "main",
      callId: "skill-call",
      tool: "load_skill",
      isError: false,
    });
    const display = state.rows.map((row) => formatTerminalRow(row)).join("\n");
    expect(display).toContain("说明已交付");
    expect(display).toContain("权限未改变");
  });
});

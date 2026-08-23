import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  advanceToolCallLifecycle,
  createToolCallLifecycle,
  projectToolCallLifecycles,
  TOOL_CALL_PHASES,
  ToolExecutionEngine,
} from "./tool-call-lifecycle.js";

describe("Tool Call 生命周期 reducer", () => {
  it("Call 记录后按唯一阶段图推进到 Capability 已解析", () => {
    const recorded = createToolCallLifecycle({
      agent: "main",
      callId: "call-1",
      tool: "read",
    });

    const resolved = advanceToolCallLifecycle(recorded, {
      phase: "capability_resolved",
      status: "completed",
    });

    expect(recorded).toMatchObject({
      currentPhase: "call_recorded",
      terminal: false,
      phases: [{ phase: "call_recorded", status: "completed" }],
    });
    expect(resolved).toMatchObject({
      currentPhase: "capability_resolved",
      terminal: false,
      phases: [
        { phase: "call_recorded", status: "completed" },
        { phase: "capability_resolved", status: "completed" },
      ],
    });
  });

  it("拒绝跳过未决阶段的迁移", () => {
    const recorded = createToolCallLifecycle({ agent: "main", callId: "call-1", tool: "read" });

    expect(() =>
      advanceToolCallLifecycle(recorded, {
        phase: "policy_resolved",
        status: "completed",
      }),
    ).toThrowError(expect.objectContaining({ code: "tool_lifecycle_invalid" }));
  });

  it("任意非下一阶段都不能绕过唯一阶段图", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TOOL_CALL_PHASES.slice(1)), (phase) => {
        const recorded = createToolCallLifecycle({
          agent: "main",
          callId: "call-property",
          tool: "read",
        });
        if (phase === "capability_resolved") return;
        expect(() =>
          advanceToolCallLifecycle(recorded, { phase, status: "completed" }),
        ).toThrowError(expect.objectContaining({ code: "tool_lifecycle_invalid" }));
      }),
    );
  });

  it("结果轴只能在负责该事实的阶段更新", () => {
    const recorded = createToolCallLifecycle({
      agent: "main",
      callId: "call-axis",
      tool: "read",
    });

    expect(() =>
      advanceToolCallLifecycle(recorded, {
        phase: "capability_resolved",
        status: "completed",
        result: { executionOutcome: "returned" },
      }),
    ).toThrowError(expect.objectContaining({ code: "tool_lifecycle_invalid" }));
  });

  it("不需要审批时保留带原因的 skipped 阶段", () => {
    const recorded = createToolCallLifecycle({ agent: "main", callId: "call-1", tool: "read" });
    const capabilityResolved = advanceToolCallLifecycle(recorded, {
      phase: "capability_resolved",
      status: "completed",
    });
    const policyResolved = advanceToolCallLifecycle(capabilityResolved, {
      phase: "policy_resolved",
      status: "completed",
    });

    const approvalSkipped = advanceToolCallLifecycle(policyResolved, {
      phase: "approval_resolved",
      status: "skipped",
      reason: "权限模式无需人工审批",
    });

    expect(approvalSkipped.phases.at(-1)).toEqual({
      phase: "approval_resolved",
      status: "skipped",
      reason: "权限模式无需人工审批",
    });
  });

  it("拒绝没有原因的 skipped 阶段", () => {
    const recorded = createToolCallLifecycle({ agent: "main", callId: "call-1", tool: "read" });

    expect(() =>
      advanceToolCallLifecycle(recorded, {
        phase: "capability_resolved",
        status: "skipped",
        reason: "",
      }),
    ).toThrowError(expect.objectContaining({ code: "tool_lifecycle_invalid" }));
  });

  it("拒绝没有原因的 failed 阶段", () => {
    const recorded = createToolCallLifecycle({ agent: "main", callId: "call-1", tool: "read" });

    expect(() =>
      advanceToolCallLifecycle(recorded, {
        phase: "capability_resolved",
        status: "failed",
        reason: "",
      }),
    ).toThrowError(expect.objectContaining({ code: "tool_lifecycle_invalid" }));
  });

  it("新 Call 建立保守且正交的初始结果轴", () => {
    const recorded = createToolCallLifecycle({ agent: "main", callId: "call-1", tool: "write" });

    expect(recorded.result).toEqual({
      executionOutcome: "not_invoked",
      effectState: "not_started",
      persistenceState: "pending",
      recoveryDisposition: "requires_human",
      cleanupState: "not_needed",
      authorizationState: "pending",
      environmentState: "available",
    });
  });

  it("拒绝会导致在线与离线 key 分叉的空白 stepId", () => {
    expect(() =>
      createToolCallLifecycle({ agent: "main", stepId: "", callId: "call-1", tool: "read" }),
    ).toThrowError(expect.objectContaining({ code: "tool_lifecycle_invalid" }));
  });

  it("结果持久化失败不抹去已返回结果与已提交 Effect", () => {
    let state = createToolCallLifecycle({ agent: "main", callId: "call-1", tool: "write" });
    for (const phase of [
      "capability_resolved",
      "policy_resolved",
      "approval_resolved",
      "lease_acquired",
      "checkpoint_durable",
      "started_durable",
      "executing",
    ] as const) {
      state = advanceToolCallLifecycle(state, { phase, status: "completed" });
    }
    state = advanceToolCallLifecycle(state, {
      phase: "observed",
      status: "completed",
      result: {
        executionOutcome: "returned",
        effectState: "committed",
        cleanupState: "pending",
      },
    });

    const failed = advanceToolCallLifecycle(state, {
      phase: "result_durable",
      status: "failed",
      reason: "Store commit 失败",
      result: { persistenceState: "failed" },
    });

    expect(failed.result).toMatchObject({
      executionOutcome: "returned",
      effectState: "committed",
      persistenceState: "failed",
      cleanupState: "pending",
    });
  });

  it("工具抛错不证明已开始的 Effect 未发生", () => {
    let state = createToolCallLifecycle({ agent: "main", callId: "call-error", tool: "write" });
    for (const phase of [
      "capability_resolved",
      "policy_resolved",
      "approval_resolved",
      "lease_acquired",
      "checkpoint_durable",
      "started_durable",
      "executing",
    ] as const) {
      state = advanceToolCallLifecycle(state, {
        phase,
        status: "completed",
        ...(phase === "started_durable" ? { result: { effectState: "started" as const } } : {}),
      });
    }

    state = advanceToolCallLifecycle(state, {
      phase: "observed",
      status: "completed",
      result: { executionOutcome: "threw", effectState: "unknown" },
    });

    expect(state.result).toMatchObject({ executionOutcome: "threw", effectState: "unknown" });
  });

  it("拒绝把已提交 Effect 回退为未开始", () => {
    let state = createToolCallLifecycle({ agent: "main", callId: "call-1", tool: "write" });
    for (const phase of [
      "capability_resolved",
      "policy_resolved",
      "approval_resolved",
      "lease_acquired",
      "checkpoint_durable",
      "started_durable",
      "executing",
    ] as const) {
      state = advanceToolCallLifecycle(state, { phase, status: "completed" });
    }
    state = advanceToolCallLifecycle(state, {
      phase: "observed",
      status: "completed",
      result: { effectState: "committed" },
    });

    expect(() =>
      advanceToolCallLifecycle(state, {
        phase: "result_durable",
        status: "completed",
        result: { effectState: "not_started" },
      }),
    ).toThrowError(expect.objectContaining({ code: "tool_lifecycle_invalid" }));
  });

  it("拒绝改写已经观测到的执行结果", () => {
    let state = createToolCallLifecycle({ agent: "main", callId: "call-1", tool: "write" });
    for (const phase of [
      "capability_resolved",
      "policy_resolved",
      "approval_resolved",
      "lease_acquired",
      "checkpoint_durable",
      "started_durable",
      "executing",
    ] as const) {
      state = advanceToolCallLifecycle(state, { phase, status: "completed" });
    }
    state = advanceToolCallLifecycle(state, {
      phase: "observed",
      status: "completed",
      result: { executionOutcome: "returned" },
    });

    expect(() =>
      advanceToolCallLifecycle(state, {
        phase: "result_durable",
        status: "completed",
        result: { executionOutcome: "threw" },
      }),
    ).toThrowError(expect.objectContaining({ code: "tool_lifecycle_invalid" }));
  });

  it("ToolExecutionEngine 只在生命周期 Fact 持久化后更新 Call 投影", async () => {
    const facts: unknown[] = [];
    const engine = new ToolExecutionEngine({
      persist: async (fact) => {
        facts.push(fact);
      },
    });

    const identity = { agent: "main", callId: "call-1" };
    await engine.recordCall({ ...identity, tool: "read" });
    await engine.advance(identity, {
      phase: "capability_resolved",
      status: "completed",
    });

    expect(facts).toHaveLength(2);
    expect(engine.inspect(identity)).toMatchObject({
      currentPhase: "capability_resolved",
      phases: [
        { phase: "call_recorded", status: "completed" },
        { phase: "capability_resolved", status: "completed" },
      ],
    });
    expect(projectToolCallLifecycles(facts)).toEqual([engine.inspect(identity)]);
  });

  it("离线投影拒绝同一 Call 身份在后续 Fact 更换工具", () => {
    expect(() =>
      projectToolCallLifecycles([
        {
          type: "tool_lifecycle",
          agent: "main",
          callId: "call-identity",
          tool: "read",
          resolution: { phase: "call_recorded", status: "completed" },
        },
        {
          type: "tool_lifecycle",
          agent: "main",
          callId: "call-identity",
          tool: "write",
          resolution: { phase: "capability_resolved", status: "completed" },
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "tool_lifecycle_invalid" }));
  });

  it("生命周期 Fact 持久化失败时不发布候选投影", async () => {
    const engine = new ToolExecutionEngine({
      persist: async () => {
        throw new Error("Store commit 失败");
      },
    });

    const identity = { agent: "main", callId: "call-1" };
    await expect(engine.recordCall({ ...identity, tool: "read" })).rejects.toThrow(
      "Store commit 失败",
    );
    expect(engine.inspect(identity)).toBeUndefined();
  });

  it("同一 Call 的并发迁移只持久化一个合法终结", async () => {
    const facts: unknown[] = [];
    const engine = new ToolExecutionEngine({
      persist: async (fact) => {
        facts.push(fact);
      },
    });
    const identity = { agent: "main", callId: "call-1" };
    await engine.recordCall({ ...identity, tool: "read" });

    const results = await Promise.allSettled([
      engine.advance(identity, { phase: "capability_resolved", status: "completed" }),
      engine.advance(identity, { phase: "capability_resolved", status: "completed" }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(facts).toHaveLength(2);
  });

  it("正常终结不会在清理门禁前宣称 quiescent", async () => {
    const engine = new ToolExecutionEngine({ persist: async () => undefined });
    const identity = { agent: "main", callId: "call-cleanup" };
    await engine.recordCall({ ...identity, tool: "write" });
    for (const phase of [
      "capability_resolved",
      "policy_resolved",
      "approval_resolved",
      "lease_acquired",
      "checkpoint_durable",
      "started_durable",
      "executing",
    ] as const) {
      await engine.advance(identity, {
        phase,
        status: "completed",
        ...(phase === "started_durable"
          ? { result: { effectState: "started" as const, cleanupState: "pending" as const } }
          : {}),
      });
    }
    await engine.advance(identity, {
      phase: "observed",
      status: "completed",
      result: { executionOutcome: "returned", effectState: "committed" },
    });

    const terminal = await engine.finalizeResult(identity);

    expect(terminal).toMatchObject({
      terminal: true,
      result: { persistenceState: "durable", cleanupState: "pending" },
    });
  });

  it("拒绝重复记录同一 Agent、Step 与 callId", async () => {
    const facts: unknown[] = [];
    const engine = new ToolExecutionEngine({
      persist: async (fact) => {
        facts.push(fact);
      },
    });
    const call = { agent: "main", stepId: "s1", callId: "call-1", tool: "read" };

    await engine.recordCall(call);
    await expect(engine.recordCall(call)).rejects.toMatchObject({
      code: "tool_lifecycle_invalid",
    });
    expect(facts).toHaveLength(1);
  });

  it("不同 Agent 的同名 callId 保持独立生命周期", async () => {
    const engine = new ToolExecutionEngine({ persist: async () => undefined });
    const planner = { agent: "planner", callId: "call-1" };
    const worker = { agent: "worker", callId: "call-1" };
    await engine.recordCall({ ...planner, tool: "read" });
    await engine.recordCall({ ...worker, tool: "write" });

    await engine.advance(planner, {
      phase: "capability_resolved",
      status: "completed",
    });

    expect(engine.inspect(planner)?.currentPhase).toBe("capability_resolved");
    expect(engine.inspect(worker)?.currentPhase).toBe("call_recorded");
  });

  it.each(["aborted", "timed_out"] as const)(
    "%s 会终结开放 Call，且可能已开始的 Effect 保持 unknown",
    async (executionOutcome) => {
      const engine = new ToolExecutionEngine({ persist: async () => undefined });
      const identity = { agent: "main", callId: `call-${executionOutcome}` };
      await engine.recordCall({ ...identity, tool: "write" });
      for (const phase of [
        "capability_resolved",
        "policy_resolved",
        "approval_resolved",
        "lease_acquired",
        "checkpoint_durable",
        "started_durable",
        "executing",
      ] as const) {
        await engine.advance(identity, {
          phase,
          status: "completed",
          ...(phase === "started_durable"
            ? { result: { effectState: "started" as const, cleanupState: "pending" as const } }
            : {}),
        });
      }

      await engine.settleInterrupted(executionOutcome, "运行终止");

      expect(engine.inspect(identity)).toMatchObject({
        currentPhase: "terminal",
        terminal: true,
        result: {
          executionOutcome,
          effectState: "unknown",
          persistenceState: "durable",
          cleanupState: "pending",
        },
      });
      await expect(
        engine.advance(identity, {
          phase: "observed",
          status: "completed",
          result: { executionOutcome: "returned" },
        }),
      ).rejects.toMatchObject({ code: "tool_lifecycle_invalid" });
    },
  );
});

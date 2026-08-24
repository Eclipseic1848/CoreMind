import { describe, expect, it } from "vitest";
import { projectContextTaskState } from "./context-task-state.js";
import type { CoreMindEvent } from "./events.js";
import type { CoreMindTraceEvent } from "./trace.js";

describe("projectContextTaskState", () => {
  it("只从 Run/Config/Trace Facts 投影不可删除集合，并保留字段来源", () => {
    const taskState = projectContextTaskState({
      runId: "run-1",
      agentName: "main",
      initialPrompt: "完成数据库迁移；不得执行发布",
      projectInstructions: "修改前必须创建 checkpoint",
      permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
      workflowSteps: [
        { id: "plan", type: "prompt" },
        { id: "verify", type: "prompt" },
      ],
      trace: [
        trace(1, "approval-required", {
          type: "approval_required",
          approvalId: "approval-1",
          runId: "run-1",
          agent: "main",
          tool: "write",
          args: {},
          risk: "high",
          effect: {
            operations: ["write"],
            paths: [],
            urls: [],
            reversible: true,
            declared: true,
          },
        }),
        trace(2, "approval-resolved", {
          type: "approval_resolved",
          approvalId: "approval-1",
          runId: "run-1",
          decision: "allow",
        }),
        trace(3, "effect-unknown", {
          type: "effect_receipt",
          idempotencyKey: "effect-1",
          tool: "write",
          status: "unknown",
        }),
        trace(4, "step-plan-done", { type: "step_end", stepId: "plan", ok: true }),
        trace(5, "checkpoint-file", {
          type: "checkpoint_created",
          checkpointId: "checkpoint-1",
          tool: "write",
          targetPath: "src/state.ts",
          reversible: true,
        }),
        trace(6, "test-command", {
          type: "tool_execution_evidence",
          agent: "main",
          tool: "bash",
          callId: "call-1",
          execution: { durationMs: 12, exitCode: 0, testCommand: true },
        }),
      ],
    });

    expect(taskState).toMatchObject({
      goal: "完成数据库迁移；不得执行发布",
      constraints: expect.arrayContaining([
        "修改前必须创建 checkpoint",
        expect.stringContaining('"network":"deny"'),
      ]),
      approvals: ["approval-1:allow"],
      uncertainEffects: ["effect-1:unknown"],
      activePlan: ["plan:completed", "verify:pending"],
      modifiedFiles: ["src/state.ts"],
      tests: ["bash:exit=0"],
      incompleteTasks: ["verify"],
      nextStep: "verify",
    });
    expect(taskState.sourceFacts.goal).toEqual(["run:run-1:start.initialPrompt"]);
    expect(taskState.sourceFacts.approvals).toEqual([
      "trace:approval-required",
      "trace:approval-resolved",
    ]);
    expect(taskState.sourceFacts.uncertainEffects).toEqual(["trace:effect-unknown"]);
    expect(taskState.sourceFacts.nextStep).toEqual(["config:workflow:verify"]);
  });

  it("Resume 使用既有 Trace Facts 重建相同已完成步骤，不读取 UI Projection", () => {
    const input = {
      runId: "run-resume",
      agentName: "main",
      initialPrompt: "继续任务",
      workflowSteps: [
        { id: "first", type: "prompt" },
        { id: "second", type: "prompt" },
      ],
      trace: [trace(1, "first-done", { type: "step_end", stepId: "first", ok: true })],
    };

    expect(projectContextTaskState(input)).toEqual(projectContextTaskState({ ...input }));
    expect(projectContextTaskState(input)).toMatchObject({
      activePlan: ["first:completed", "second:pending"],
      incompleteTasks: ["second"],
      nextStep: "second",
    });
  });
});

function trace(sequence: number, eventId: string, event: CoreMindEvent): CoreMindTraceEvent {
  return {
    eventId,
    runId: "run-1",
    sequence,
    timestamp: new Date(sequence).toISOString(),
    event,
  };
}

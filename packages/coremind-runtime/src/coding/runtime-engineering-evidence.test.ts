import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "../events.js";
import {
  assessRuntimeEngineeringEvidence,
  commandFingerprint,
  createToolExecutionEvidence,
} from "./runtime-engineering-evidence.js";

describe("Runtime engineering evidence", () => {
  it("只在真实测试、回归、Checkpoint 与 Diff 全部存在时通过", () => {
    const stepId = "loop-verify-1";
    const events: CoreMindEvent[] = [
      {
        type: "checkpoint_created",
        checkpointId: "checkpoint-1",
        tool: "write",
        reversible: true,
      },
      execution("node --test tests/a.test.js", stepId),
      execution("npm test", stepId),
      { type: "tool_result", agent: "reviewer", tool: "git_diff", isError: false, stepId },
    ];

    expect(
      assessRuntimeEngineeringEvidence(
        events,
        { mode: "runtime", regressionCommand: "npm test", minSuccessfulTestCommands: 2 },
        stepId,
      ),
    ).toMatchObject({
      passed: true,
      successfulTestCommands: 2,
      regressionCommandMatched: true,
      checkpointRecorded: true,
      diffReviewed: true,
    });
  });

  it("模型口头 PASS 不能替代 Runtime 证据", () => {
    const report = assessRuntimeEngineeringEvidence(
      [],
      { mode: "runtime", regressionCommand: "npm test" },
      "loop-verify-1",
    );
    expect(report.passed).toBe(false);
    expect(report.reasons).toHaveLength(4);
  });

  it("命令证据不保存命令原文并识别失败退出码", () => {
    const command = "npm test -- --runInBand";
    const evidence = createToolExecutionEvidence({
      tool: "bash",
      args: { command },
      isError: true,
      result: { content: [{ type: "text", text: "Command exited with code 3" }] },
      durationMs: 25,
    });
    expect(evidence).toEqual({
      durationMs: 25,
      exitCode: 3,
      commandSha256: commandFingerprint(command),
      testCommand: true,
    });
    expect(JSON.stringify(evidence)).not.toContain(command);
  });
});

function execution(command: string, stepId: string): CoreMindEvent {
  return {
    type: "tool_execution_evidence",
    agent: "reviewer",
    tool: "bash",
    callId: command,
    stepId,
    execution: {
      durationMs: 10,
      exitCode: 0,
      commandSha256: commandFingerprint(command),
      testCommand: true,
    },
  };
}

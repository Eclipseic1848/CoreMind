import { describe, expect, it } from "vitest";
import {
  defineExperiment,
  ExperimentError,
  runExperiment,
  selectExperimentArm,
} from "./experiment.js";

const experiment = defineExperiment({
  id: "repair-prompt",
  version: "2026-08-11.1",
  seed: "phase2",
  arms: [
    { id: "control", weight: 1, config: { prompt: "baseline" } },
    { id: "candidate", weight: 3, config: { prompt: "candidate" } },
  ],
});

describe("experiment", () => {
  it("同一版本、seed 与输入指纹始终选择同一 arm", () => {
    const first = selectExperimentArm(experiment, "sha256:input-a");
    const second = selectExperimentArm(experiment, "sha256:input-a");

    expect(second).toEqual(first);
    expect(first.sample).toBeGreaterThanOrEqual(0);
    expect(first.sample).toBeLessThan(1);
  });

  it("执行 experiment → arm → run → trace，并复用 grader 证据", async () => {
    const record = await runExperiment({
      definition: experiment,
      inputFingerprint: "sha256:fixture",
      environment: {
        platform: "win32-x64",
        runtimeVersion: "0.3.0-beta.2",
        provider: "probe",
        model: "probe-model",
      },
      run: async (arm) => ({
        runId: `run-${arm.id}`,
        outcome: { status: "succeeded", finishReason: "completed" },
        metrics: {
          durationMs: 12,
          turns: 1,
          steps: { total: 0, succeeded: 0, failed: 0 },
          toolCalls: 0,
          toolFailures: 0,
          retries: 0,
          outputChars: 2,
        },
        approvalCount: 0,
        trace: [
          {
            schemaVersion: 1,
            runId: `run-${arm.id}`,
            sequence: 1,
            timestamp: "2026-08-11T00:00:00.000Z",
            event: { type: "agent_start", agent: "main" },
          },
        ],
        graderResults: [{ id: "outcome", type: "outcome", passed: true }],
      }),
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      experiment: { id: "repair-prompt", version: "2026-08-11.1" },
      inputFingerprint: "sha256:fixture",
      environment: { provider: "probe", model: "probe-model" },
      run: { outcome: { status: "succeeded" }, approvalCount: 0 },
    });
    expect(record.selection.armId).toMatch(/control|candidate/);
    expect(record.run.trace).toHaveLength(1);
    expect(record.run.graderResults).toContainEqual(
      expect.objectContaining({ id: "outcome", passed: true }),
    );
  });

  it("拒绝重复 arm、空版本和无效权重", () => {
    expect(() =>
      defineExperiment({
        id: "bad",
        version: "",
        seed: "x",
        arms: [{ id: "a", weight: 1 }],
      }),
    ).toThrow(ExperimentError);
    expect(() =>
      defineExperiment({
        id: "bad",
        version: "1",
        seed: "x",
        arms: [
          { id: "a", weight: 1 },
          { id: "a", weight: 0 },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "experiment_invalid" }));
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTrustedToolFaultFailure,
  FAULT_KINDS,
  FAULT_MATRIX_SCENARIO_COUNT,
  FAULT_POINTS,
  FAULT_TIMINGS,
  generateTrustedToolFaultScenario,
  runTrustedToolFaultMatrix,
  TOOL_EFFECTS,
} from "./trusted-tool-fault-matrix.mjs";
import {
  createActualFaultInjector,
  createFaultResourceTracker,
  summarizeFaultResources,
} from "./trusted-tool-fault-probes.mjs";
import { runLiveBoundaryProbe } from "./trusted-tool-live-boundary-probes.mjs";

describe("0.3.x-B 独立可信工具故障矩阵", () => {
  it("真实边界机制失败保留实际身份与最小 Fact 前缀", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "coremind-live-boundary-failure-"));
    const tracker = createFaultResourceTracker();
    const scenario = {
      seed: 9_999,
      point: "missing_boundary",
      kind: "sync_throw",
      effect: "unknown",
      timing: "before",
    };
    let rejection: unknown;
    try {
      await runLiveBoundaryProbe(scenario, workspaceRoot, tracker);
    } catch (error) {
      rejection = error;
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }

    const failure = createTrustedToolFaultFailure(scenario, rejection);
    expect(failure).toMatchObject({
      seed: 9_999,
      runId: "live-boundary-run-9999",
      callId: "live-boundary-call-9999",
      receiptId: "live-boundary-run-9999:fault-step:live-boundary-call-9999",
      point: "missing_boundary",
      kind: "sync_throw",
    });
    expect(failure.factPrefix.slice(0, 2)).toEqual([
      { phase: "call_recorded", status: "completed" },
      { phase: "capability_resolved", status: "completed" },
    ]);
    expect(failure.factPrefix.length).toBeGreaterThan(0);
    expect(summarizeFaultResources(tracker)).toEqual({
      pendingPromises: 0,
      liveWorkers: 0,
      liveProcesses: 0,
      heldLeases: 0,
    });
  });

  it("during 将原生拒绝直接传给实际边界且保留最小前缀", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "coremind-fault-rejection-"));
    const tracker = createFaultResourceTracker();
    const injector = createActualFaultInjector(
      { seed: 0, point: "policy", kind: "async_reject", effect: "network", timing: "during" },
      workspaceRoot,
      tracker,
    );
    let operationCommitted = false;
    let rejection: Record<string, unknown> | undefined;
    try {
      await injector.run("policy", () =>
        injector.intercept("policy", async () => {
          operationCommitted = true;
        }),
      );
    } catch (error) {
      rejection = error as Record<string, unknown>;
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }

    expect(operationCommitted).toBe(false);
    expect(rejection).toMatchObject({
      code: "injected_async_reject",
      injectedFault: true,
      factPrefix: [{ point: "policy", status: "injected_during" }],
    });
    expect(injector.evidence.mechanismCode).toBe("injected_async_reject");
  });

  it("Runtime 的唯一 Tool Adapter 调用点受 ToolExecutionEngine 门禁包裹", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "packages", "coremind-runtime", "src", "runtime.ts"),
      "utf8",
    );
    const directCalls = [...source.matchAll(/tool\.execute\(/g)];

    expect(directCalls).toHaveLength(1);
    const callIndex = directCalls[0]!.index!;
    const gateIndex = source.lastIndexOf("toolExecutionEngine.executeAdapter", callIndex);
    expect(gateIndex).toBeGreaterThan(callIndex - 300);
  });

  it("固定 seed 覆盖 Effect、切点、故障类型与时序的完整笛卡尔积", () => {
    const scenarios = Array.from({ length: FAULT_MATRIX_SCENARIO_COUNT }, (_, seed) =>
      generateTrustedToolFaultScenario(seed),
    );

    expect(new Set(scenarios.map((scenario) => scenario.point))).toEqual(new Set(FAULT_POINTS));
    expect(new Set(scenarios.map((scenario) => scenario.kind))).toEqual(new Set(FAULT_KINDS));
    expect(new Set(scenarios.map((scenario) => scenario.effect))).toEqual(new Set(TOOL_EFFECTS));
    expect(new Set(scenarios.map((scenario) => scenario.timing))).toEqual(new Set(FAULT_TIMINGS));
    expect(
      new Set(
        scenarios.map((scenario) =>
          [scenario.effect, scenario.point, scenario.kind, scenario.timing].join("|"),
        ),
      ).size,
    ).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(generateTrustedToolFaultScenario(731)).toEqual(generateTrustedToolFaultScenario(731));
  });

  it("每个 seed 独立检查 B-1～B-10，失败报告不包含输入正文", async () => {
    const report = await runTrustedToolFaultMatrix({
      seedStart: 0,
      seedEnd: FAULT_MATRIX_SCENARIO_COUNT,
      batchSize: 20,
      secretInput: "不得出现在证据里的用户正文",
      runEntryParityProbe: true,
    });

    expect(report.failures, JSON.stringify(report.failures)).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.scenarioCount).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.invariantPasses).toEqual({
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`B-${index + 1}`, FAULT_MATRIX_SCENARIO_COUNT]),
      ),
      "B-10": 1,
    });
    expect(report.bindingConflictRejections).toBe(5 * FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.capabilityConflictRejections).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.externalResumeBlocks).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.unsafeResumeBlocks).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.projectionRebuilds).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.parallelBatchCount).toBeGreaterThan(1);
    expect(report.faultInjectionCounts).toEqual(
      Object.fromEntries(
        FAULT_KINDS.map((kind) => [
          kind,
          Array.from({ length: FAULT_MATRIX_SCENARIO_COUNT }, (_, seed) =>
            generateTrustedToolFaultScenario(seed),
          ).filter((scenario) => scenario.kind === kind).length,
        ]),
      ),
    );
    expect(report.actualFaultProbes).toMatchObject({
      workerExits: expect.any(Number),
      cancellations: expect.any(Number),
      timeouts: expect.any(Number),
      storeFailures: expect.any(Number),
      lateResults: expect.any(Number),
      ownedCrashes: expect.any(Number),
    });
    expect(report.actualFaultProbes.workerExits).toBeGreaterThan(0);
    expect(report.actualFaultProbes.ownedCrashes).toBe(
      2 * FAULT_POINTS.length * FAULT_TIMINGS.length * TOOL_EFFECTS.length,
    );
    expect(new Set(report.ownedCrashCoverage)).toEqual(
      new Set(
        ["process_crash", "owner_exit"].flatMap((kind) =>
          FAULT_POINTS.flatMap((point) =>
            FAULT_TIMINGS.flatMap((timing) =>
              TOOL_EFFECTS.map((effect) => [kind, point, timing, effect].join(":")),
            ),
          ),
        ),
      ),
    );
    expect(new Set(report.actualBoundaryCoverage)).toEqual(
      new Set(
        FAULT_KINDS.flatMap((kind) =>
          FAULT_POINTS.flatMap((point) =>
            FAULT_TIMINGS.flatMap((timing) =>
              TOOL_EFFECTS.map((effect) => [kind, point, timing, effect].join(":")),
            ),
          ),
        ),
      ),
    );
    expect(report.ownedProcessConcurrency).toEqual({
      limit: 4,
      peak: 4,
      active: 0,
      waiting: 0,
    });
    expect(report.entryProjectionProbe).toEqual({
      status: "passed",
      entries: ["cli", "tui", "typescript", "python"],
      fixtures: ["success", "tool_error"],
      source: "packages/coremind-cli/src/entry-equivalence.acceptance.test.tsx",
    });
    expect(report.resourceSummary).toEqual({
      pendingPromises: 0,
      liveWorkers: 0,
      liveProcesses: 0,
      heldLeases: 0,
    });
    const workspaceScenarioCount = Array.from({ length: FAULT_MATRIX_SCENARIO_COUNT }, (_, seed) =>
      generateTrustedToolFaultScenario(seed),
    ).filter((scenario) => scenario.effect === "workspace").length;
    expect(report.leaseConflictRejections).toBe(workspaceScenarioCount);
    expect(report.nonQuiescentReleaseRejections).toBe(workspaceScenarioCount);
    expect(report.lateTerminalRejections).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.invariantGatePasses).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.adapterBypassRejections).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.integratedFaultInjections).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.invariantFactPrefixChecks).toBe(FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.invariantFactsSource).toBe("tool_execution_engine");
    expect(report.axisIsolationPasses).toBe(5 * FAULT_MATRIX_SCENARIO_COUNT);
    expect(report.actualEffectExecutions).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("不得出现在证据里的用户正文");
  }, 900_000);

  it("单 seed 回放报告包含身份、切点与最小 Fact 前缀", async () => {
    const report = await runTrustedToolFaultMatrix({ seedStart: 417, seedEnd: 418 });

    expect(report.replay).toMatchObject({
      seed: 417,
      runId: "fault-run-417",
      callId: "fault-call-417",
      receiptId: "fault-run-417:fault-step:fault-call-417",
      point: expect.any(String),
      factPrefix: expect.any(Array),
    });
    expect(report.replay?.factPrefix.length).toBeLessThanOrEqual(6);
  });
});

import { createFakeExecutionEnvironment } from "coremind-tools/internal";
import { describe, expect, it } from "vitest";
import type { AgentDriver } from "./agent-driver.js";
import type { ChildRunCoordinator } from "./child-run.js";
import { RunContext } from "./run-context.js";

describe("RunContext", () => {
  it("两个实例的 agent、harness 与会话持久化决策互不串扰", () => {
    const first = new RunContext<{ owner: string }>();
    const second = new RunContext<{ owner: string }>();
    const firstAgent = {
      prompt: async () => {},
      waitForIdle: async () => {},
      abort: () => {},
      messages: () => [{ role: "assistant", content: "first" }],
      status: () => ({ running: false, pendingToolCalls: 0, queuedControls: 0 }),
      queueControl: () => {},
    } satisfies AgentDriver;

    first.registerAgent("main", firstAgent);
    first.setHarnessFactory(() => ({ owner: "first" }));
    first.setSessionPersistPaused(true);

    expect(first.harnessFor("main")).toEqual({ owner: "first" });
    expect(first.collectMessages().get("main")).toHaveLength(1);
    expect(first.shouldTrimRejectedTrail()).toBe(true);
    expect(second.harnessFor("main")).toBeUndefined();
    expect(second.collectMessages()).toEqual(new Map());
    expect(second.shouldTrimRejectedTrail()).toBe(false);
  });

  it("环境资源参与 Quiescent，终止失败会保留结构化错误", async () => {
    const context = new RunContext<never>();
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
      terminationTimeoutMs: 10,
    });
    context.attachExecutionEnvironment(environment);
    const activity = environment.beginActivity({ id: "network-1", kind: "network" });

    expect(context.isQuiescent()).toBe(false);
    await expect(context.terminateEnvironment("测试取消")).rejects.toMatchObject({
      code: "environment_terminate_failed",
    });
    expect(context.environmentTerminationError()).toMatchObject({
      code: "environment_terminate_failed",
    });

    activity.settle();
    expect(context.isQuiescent()).toBe(true);
  });

  it("Child Run 参与父 Run 的取消传播与 Quiescent 判定", async () => {
    const context = new RunContext<never>();
    let quiescent = false;
    let cancelReason: string | undefined;
    context.attachChildRuns({
      isQuiescent: () => quiescent,
      isExecutionQuiescent: () => true,
      cancelAll: async (reason: string) => {
        cancelReason = reason;
        quiescent = true;
      },
    } as ChildRunCoordinator);

    expect(context.isExecutionQuiescent()).toBe(true);
    expect(context.isQuiescent()).toBe(false);
    await context.cancelChildRuns("父 Runtime 取消");
    expect(cancelReason).toBe("父 Runtime 取消");
    expect(context.isQuiescent()).toBe(true);
  });
});

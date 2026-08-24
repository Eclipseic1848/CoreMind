import type { Agent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { RunContext } from "./run-context.js";

describe("RunContext", () => {
  it("两个实例的 agent、harness 与会话持久化决策互不串扰", () => {
    const first = new RunContext<{ owner: string }>();
    const second = new RunContext<{ owner: string }>();
    const firstAgent = {
      abort: () => {},
      state: { messages: [{ role: "assistant", content: "first" }] },
    } as unknown as Agent;

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
});

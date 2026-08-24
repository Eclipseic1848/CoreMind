import { describe, expect, it } from "vitest";
import type { RunContext } from "./run-context.js";
import { RunKernel, type RunKernelDependency } from "./run-kernel.js";

describe("RunKernel", () => {
  it("生产与 Fake 共用同一依赖缝隙，并明确拒绝同实例并发", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const contexts: Array<RunContext<{ owner: string }>> = [];
    const fake: RunKernelDependency<{ owner: string }, string> = {
      execute: async (context) => {
        contexts.push(context);
        await gate;
        return `run-${contexts.length}`;
      },
    };
    const kernel = new RunKernel(fake);

    const first = kernel.run();
    await expect(kernel.run()).rejects.toMatchObject({ code: "concurrent_run" });
    release();

    await expect(first).resolves.toBe("run-1");
    await expect(kernel.run()).resolves.toBe("run-2");
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(kernel.currentContext()).toBe(contexts[1]);
  });
});

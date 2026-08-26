import path from "node:path";
import { ProcessRunner } from "coremind-tools";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import { LoopController } from "./loop-controller.js";
import { RunTerminalizer } from "./run-terminalizer.js";
import { ToolPolicy } from "./tool-policy.js";

describe("Batch 8 属性测试", () => {
  it("任意层数的父目录逃逸都被权限层拒绝", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.stringMatching(/^[a-z]{1,12}$/),
        async (depth, name) => {
          const candidate = path.join(...Array.from({ length: depth }, () => ".."), `${name}.txt`);
          const policy = new ToolPolicy({
            cwd: path.resolve("workspace"),
            runId: "property-path",
            permissions: { mode: "full", workspaceOnly: true, network: "allow" },
            createApprovalId: () => "approval",
          });
          const decision = await policy.authorize("main", "write", { path: candidate });
          expect(decision.allowed).toBe(false);
          expect(decision.reason).toContain("路径超出工作区");
        },
      ),
      { numRuns: 60, seed: 60801 },
    );
  });

  it("Windows Shell 只有完全访问、关闭工作区限制且允许网络时自动放行", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("ask", "assisted", "full" as const),
        fc.boolean(),
        fc.constantFrom("ask", "allow", "deny" as const),
        async (mode, workspaceOnly, network) => {
          const policy = new ToolPolicy({
            cwd: process.cwd(),
            runId: "property-permission",
            permissions: { mode, workspaceOnly, network },
            platform: "win32",
            createApprovalId: () => "approval",
          });
          const decision = await policy.authorize("main", "bash", { command: "node --version" });
          expect(decision.allowed).toBe(
            mode === "full" && workspaceOnly === false && network === "allow",
          );
        },
      ),
      { numRuns: 50, seed: 60802 },
    );
  });

  it("任意非致命事件前缀都不会覆盖明确的运行错误终态", () => {
    const eventArbitrary = fc.oneof(
      fc.constant<CoreMindEvent>({ type: "agent_start", agent: "main" }),
      fc.constant<CoreMindEvent>({ type: "agent_end", agent: "main" }),
      fc.constant<CoreMindEvent>({
        type: "policy_denied",
        agent: "main",
        tool: "write",
        reason: "拒绝",
      }),
    );
    fc.assert(
      fc.property(
        fc.array(eventArbitrary, { maxLength: 50 }),
        fc.constantFrom("aborted", "run_timeout", "budget_exceeded", "agent_failed"),
        (events, code) => {
          const outcome = new RunTerminalizer().terminalize(
            events,
            new CoreMindError(code, "property failure"),
          );
          const expected =
            code === "aborted"
              ? "aborted"
              : code === "run_timeout"
                ? "timeout"
                : code === "budget_exceeded"
                  ? "budget_exceeded"
                  : "failed";
          expect(outcome.status).toBe(expected);
          expect(outcome.finishReason).toBe(code);
        },
      ),
      { numRuns: 80, seed: 60803 },
    );
  });

  // 20 次真实进程启动/终止在整仓并发压力下会超过项目默认 15 秒；单次产品门仍为 2 秒。
  it("取消发生在任意短延迟时都终止进程", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 20 }), async (delayMs) => {
        const controller = new AbortController();
        const running = new ProcessRunner().run({
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          signal: controller.signal,
          timeoutMs: 2_000,
        });
        setTimeout(() => controller.abort(), delayMs);
        await expect(running).rejects.toMatchObject({ code: "process_aborted" });
      }),
      { numRuns: 20, seed: 60804 },
    );
  }, 60_000);

  it("重复动作在配置阈值内必然收敛到无进展终态", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (threshold) => {
        const controller = new LoopController({
          runId: "property-loop",
          configFingerprint: "fingerprint",
          hasPlanning: false,
          maxIterations: 100,
          maxRepairs: 100,
          maxRepeatedAction: threshold,
          onFailure: "repair",
          onExhausted: "fail",
        });
        controller.send({ type: "START" });
        for (let action = 0; action < threshold && controller.phase !== "failed"; action++) {
          controller.send(
            controller.phase === "executing"
              ? { type: "EXECUTED", fingerprint: "same-action" }
              : { type: "REPAIRED", fingerprint: "same-action" },
          );
          if (controller.phase === "verifying") {
            controller.send({ type: "VERIFIED", passed: false });
          }
        }
        expect(controller.phase).toBe("failed");
        expect(controller.getSnapshot().failureCode).toBe("loop_no_progress");
      }),
      { numRuns: 40, seed: 60805 },
    );
  });
});

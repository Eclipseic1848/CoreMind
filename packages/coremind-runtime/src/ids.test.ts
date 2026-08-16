import { describe, expect, it } from "vitest";
import { legacyStepId, receiptId } from "./ids.js";

// 规格 02（docs/spec/0.3.x-a/02-identity-and-invariants.md §2）的身份契约。
describe("身份与 ReceiptId 单点实现", () => {
  it("receiptId 无 stepId 时为 runId:callId", () => {
    expect(receiptId("run-1", undefined, "call-a")).toBe("run-1:call-a");
  });

  it("receiptId 有 stepId 时为 runId:stepId:callId", () => {
    expect(receiptId("run-1", "loop-execute:0", "call-a")).toBe("run-1:loop-execute:0:call-a");
  });

  it("legacyStepId 映射 0.3.0 旧模板到新模板（读取兼容，不重写持久记录）", () => {
    // 0.3.0 的 loop-execute 无 iteration 后缀，恢复时任何 iteration 都回退到旧键
    expect(legacyStepId("loop-execute:0")).toBe("loop-execute");
    expect(legacyStepId("loop-execute:3")).toBe("loop-execute");
    // 0.3.0 的 verify/repair 用连字符，iteration 一一对应
    expect(legacyStepId("loop-verify:2")).toBe("loop-verify-2");
    expect(legacyStepId("loop-repair:1")).toBe("loop-repair-1");
    // 新 run 的键没有 legacy 形式时返回 undefined
    expect(legacyStepId("configured-step")).toBeUndefined();
  });
});

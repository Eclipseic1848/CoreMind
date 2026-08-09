import { describe, expect, it } from "vitest";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import { RunTerminalizer } from "./run-terminalizer.js";

describe("RunTerminalizer", () => {
  it("同一运行既有成功工具结果又有权限拒绝时仍返回 paused", () => {
    const events: CoreMindEvent[] = [
      { type: "tool_result", agent: "main", tool: "read", isError: false },
      { type: "policy_denied", agent: "main", tool: "write", reason: "用户拒绝" },
    ];

    expect(new RunTerminalizer().terminalize(events)).toEqual({
      status: "paused",
      finishReason: "tool_approval_denied",
    });
  });

  it.each([
    ["aborted", "aborted"],
    ["run_timeout", "timeout"],
    ["step_timeout", "timeout"],
    ["budget_exceeded", "budget_exceeded"],
    ["retry_limit", "budget_exceeded"],
    ["agent_failed", "failed"],
  ] as const)("错误码 %s 映射为终态 %s", (code, status) => {
    expect(
      new RunTerminalizer().terminalize([], new CoreMindError(code, "测试错误")),
    ).toMatchObject({ status, finishReason: code, error: { code } });
  });

  it("没有错误或拒绝事件时返回 succeeded", () => {
    expect(new RunTerminalizer().terminalize([])).toEqual({
      status: "succeeded",
      finishReason: "completed",
    });
  });

  it("Loop 的显式暂停保持 paused 终态", () => {
    expect(
      new RunTerminalizer().terminalize([], new CoreMindError("loop_paused", "等待人工继续")),
    ).toMatchObject({ status: "paused", finishReason: "loop_paused" });
  });

  it.each([
    [new Error("普通错误"), "普通错误"],
    ["字符串错误", "字符串错误"],
  ])("把非 CoreMind 错误安全归一化为 unknown", (error, message) => {
    expect(new RunTerminalizer().terminalize([], error)).toEqual({
      status: "failed",
      finishReason: "unknown",
      error: { code: "unknown", message },
    });
  });
});

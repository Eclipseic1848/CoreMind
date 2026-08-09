import { describe, expect, it } from "vitest";
import { loopStateLine } from "./render.js";

describe("Loop 终端渲染", () => {
  it("把内部状态转换为新手可读的进度", () => {
    expect(loopStateLine("repairing", 2, 1)).toContain("修复中 · 第 2 轮 · 已修复 1 次");
    expect(loopStateLine("paused", 2, 1)).toContain("已暂停");
  });
});

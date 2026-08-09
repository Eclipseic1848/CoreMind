import { describe, expect, it } from "vitest";
import { exitCodeForRunStatus } from "./run.js";

describe("run 终态退出码", () => {
  it.each([
    ["succeeded", 0],
    ["failed", 1],
    ["paused", 2],
    ["budget_exceeded", 3],
    ["timeout", 124],
    ["aborted", 130],
  ] as const)("%s 返回 %i", (status, expected) => {
    expect(exitCodeForRunStatus(status)).toBe(expected);
  });
});

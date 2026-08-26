import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildLinuxSandboxProbeScript } from "./platform-execution-environment.js";

describe("平台执行环境探针", () => {
  it("生成可由 Node 解析的 Linux sandbox 负向探针脚本", () => {
    const script = buildLinuxSandboxProbeScript("/tmp/outside.txt", 31_337);

    expect(() =>
      execFileSync(process.execPath, ["--check", "-"], {
        input: script,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ).not.toThrow();
  });
});

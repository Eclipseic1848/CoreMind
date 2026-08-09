import { describe, expect, it } from "vitest";
import { evaluateSourceArchiveEntries } from "./validate-source-archive.mjs";

describe("源码 ZIP 内容门禁", () => {
  it("允许公开源码、测试和环境变量示例", () => {
    const result = evaluateSourceArchiveEntries([
      "coremind-source/package.json",
      "coremind-source/packages/coremind-cli/src/cli.ts",
      "coremind-source/packages/coremind-cli/src/cli.e2e.test.ts",
      "coremind-source/.env.example",
      "coremind-source/examples/golden/demo/.coremind/checkpoints/.gitkeep",
    ]);

    expect(result).toEqual([]);
  });

  it("拒绝内部计划、凭据、运行状态、依赖与生成缓存", () => {
    const result = evaluateSourceArchiveEntries([
      "coremind-source/handoff.md",
      "coremind-source/docs/analysis/private.md",
      "coremind-source/.env",
      "coremind-source/.npmrc",
      "coremind-source/node_modules/pkg/index.js",
      "coremind-source/.coremind/runs/run.jsonl",
      "coremind-source/python/.pytest_cache/CACHEDIR.TAG",
      "coremind-source/coverage/coverage-summary.json",
    ]);

    expect(result.join("\n")).toContain("handoff.md");
    expect(result.join("\n")).toContain("docs/analysis");
    expect(result.join("\n")).toContain(".env");
    expect(result.join("\n")).toContain("node_modules");
    expect(result.join("\n")).toContain(".coremind/runs");
    expect(result.join("\n")).toContain(".pytest_cache");
  });
});

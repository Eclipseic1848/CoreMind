import { describe, expect, it } from "vitest";
import { evaluatePackageFiles } from "./package-artifacts.mjs";

describe("npm 发布包内容门禁", () => {
  it("拒绝测试、内部计划、运行状态、checkpoint、会话和环境文件", () => {
    const result = evaluatePackageFiles({
      packageName: "coremind-cli",
      declaredFiles: ["dist", "README.md"],
      packedFiles: [
        "package.json",
        "README.md",
        "dist/index.js",
        "dist/tui.test.js",
        "dist/tui.test.d.ts",
        "dist/tui.test.js.map",
        "docs/analysis/private.md",
        ".coremind/runs/run.jsonl",
        ".coremind/checkpoints/item.json",
        "sessions/demo.jsonl",
        ".env",
      ],
      requiredFiles: ["dist/index.js", "dist/index.d.ts"],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers.join("\n")).toContain("tui.test.js");
    expect(result.blockers.join("\n")).toContain("docs/analysis/private.md");
    expect(result.blockers.join("\n")).toContain(".coremind/runs/run.jsonl");
    expect(result.blockers.join("\n")).toContain("sessions/demo.jsonl");
    expect(result.blockers.join("\n")).toContain(".env");
    expect(result.blockers.join("\n")).toContain("缺少入口：dist/index.d.ts");
  });

  it("接受 allowlist 内的运行时代码、类型、source map 和模板", () => {
    const result = evaluatePackageFiles({
      packageName: "coremind-templates",
      declaredFiles: ["dist", "templates", "skills", "README.md"],
      packedFiles: [
        "package.json",
        "README.md",
        "dist/index.js",
        "dist/index.js.map",
        "dist/index.d.ts",
        "dist/index.d.ts.map",
        "templates/blog/coremind.yaml",
        "templates/blog/.env.example",
        "skills/writer/README.md",
      ],
      requiredFiles: ["dist/index.js", "dist/index.d.ts"],
    });

    expect(result).toEqual({ ready: true, blockers: [] });
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectRequiredEntries, evaluatePackageFiles } from "./package-artifacts.mjs";

describe("npm 发布包内容门禁", () => {
  it("Windows MCP 六个冻结资产均为必需的发布入口", () => {
    const assets = [
      "service.mjs",
      "guard.dll",
      "host.exe",
      "manifest.json",
      "metafile.json",
      "THIRD-PARTY-LICENSES.txt",
    ].map((filename) => `dist/vendor/windows-mcp/${filename}`);
    const requiredFiles = collectRequiredEntries({
      name: "coremind-tools",
      main: "./dist/index.js",
    });
    expect(requiredFiles).toEqual([...assets, "dist/index.js"]);
    const packedFiles = [...assets, "dist/index.js"];
    expect(
      evaluatePackageFiles({
        packageName: "coremind-tools",
        declaredFiles: ["dist"],
        packedFiles,
        requiredFiles,
      }),
    ).toEqual({ ready: true, blockers: [] });
    for (const missing of assets) {
      expect(
        evaluatePackageFiles({
          packageName: "coremind-tools",
          declaredFiles: ["dist"],
          packedFiles: packedFiles.filter((filename) => filename !== missing),
          requiredFiles,
        }),
      ).toEqual({ ready: false, blockers: [`coremind-tools 缺少入口：${missing}`] });
    }
  });

  it("接受真实会话实现的代码、类型和 source map 编译产物", () => {
    const modules = readdirSync(
      new URL("../packages/coremind-runtime/src/session-v4/session/", import.meta.url),
      { recursive: true, encoding: "utf8" },
    )
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.replaceAll("\\", "/").replace(/\.ts$/, ""));
    expect(modules.length).toBeGreaterThan(0);
    const result = evaluatePackageFiles({
      packageName: "coremind-runtime",
      declaredFiles: ["dist"],
      packedFiles: modules.flatMap((name) =>
        ["js", "js.map", "d.ts", "d.ts.map"].map(
          (extension) => `dist/session-v4/session/${name}.${extension}`,
        ),
      ),
      requiredFiles: ["dist/session-v4/session/session.js"],
    });
    expect(result).toEqual({ ready: true, blockers: [] });
  });

  it.each([
    ["coremind-runtime", "dist/session-v4/session/record.jsonl"],
    ["coremind-runtime", "dist/session-v4/session/state.json"],
    ["coremind-runtime", "dist/session-v4/session/.env"],
    ["coremind-runtime", "dist/session-v4/session/private.js"],
    ["coremind-runtime", "dist/session-v4/session/session.test.js"],
    ["coremind-runtime", "dist/session-v4/session/fixtures/context.js"],
    ["coremind-runtime", "dist/session-v4/session/.coremind/runs/run.jsonl"],
    ["coremind-runtime", "dist/session-v4/sessions/session.js"],
    ["coremind-cli", "dist/session-v4/session/session.js"],
  ])("仍拒绝 %s 中的会话数据或伪装编译文件 %s", (packageName, file) => {
    const result = evaluatePackageFiles({
      packageName,
      declaredFiles: ["dist"],
      packedFiles: [file],
      requiredFiles: [],
    });
    expect(result).toEqual({
      ready: false,
      blockers: [`${packageName} 包含禁止发布的文件：${file}`],
    });
  });

  it("会话实现编译产物仍须显式声明在 allowlist 内", () => {
    const file = "dist/session-v4/session/session.js";
    const result = evaluatePackageFiles({
      packageName: "coremind-runtime",
      declaredFiles: [],
      packedFiles: [file],
      requiredFiles: [],
    });
    expect(result).toEqual({
      ready: false,
      blockers: [`coremind-runtime 文件不在 package.json files allowlist：${file}`],
    });
  });

  it("模板清单保留技能目录并声明内部运行时与类型入口", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../packages/coremind-templates/package.json", import.meta.url), "utf8"),
    );
    expect(manifest.files).toContain("skills");
    expect(manifest.exports["./internal"]).toEqual({
      types: "./dist/internal.d.ts",
      import: "./dist/internal.js",
    });
  });

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
        "dist/internal.js",
        "dist/internal.d.ts",
        "templates/blog/coremind.yaml",
        "templates/blog/.env.example",
        "skills/writer/README.md",
        "skills/writer/SKILL.md",
      ],
      requiredFiles: ["dist/index.js", "dist/index.d.ts", "dist/internal.js", "dist/internal.d.ts"],
    });

    expect(result).toEqual({ ready: true, blockers: [] });
  });

  it.each(["dist/internal.js", "dist/internal.d.ts"])("拒绝缺少模板内部入口 %s", (entry) => {
    const result = evaluatePackageFiles({
      packageName: "coremind-templates",
      declaredFiles: ["dist", "skills"],
      packedFiles: [
        "package.json",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/internal.js",
        "dist/internal.d.ts",
        "skills/writer/README.md",
        "skills/writer/SKILL.md",
      ].filter((name) => name !== entry),
      requiredFiles: ["dist/index.js", "dist/index.d.ts", "dist/internal.js", "dist/internal.d.ts"],
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([`coremind-templates 缺少入口：${entry}`]);
  });
});

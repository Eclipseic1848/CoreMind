import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertExistingReleaseNotes, renderControlledReleaseNotes } from "./release-notes.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = "a".repeat(40);
const identity = {
  version: "1.1.0",
  requestedTag: "v1.1.0",
  headSha: sha,
  tagSha: sha,
  dirty: false,
};
const template = [
  "# CoreMind v1.1.0",
  "",
  "Version: 1.1.0",
  "Tag: v1.1.0",
  "Commit: {{RELEASE_COMMIT}}",
  "",
  "## 简体中文",
  "",
  "已审阅的中文说明，保留正文内部  空格。",
  "",
  "## English",
  "",
  "Reviewed release text; preserve internal  spaces.",
  "",
].join("\n");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    const target = path.resolve(directory);
    if (
      path.resolve(path.dirname(target)) !== path.resolve(tmpdir()) ||
      !path.basename(target).startsWith("coremind-release-notes-")
    ) {
      throw new Error("拒绝清理不属于本测试的临时目录");
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("受控发布说明", () => {
  it("只替换已验证的完整提交，保留固定中英正文", () => {
    expect(renderControlledReleaseNotes(template, identity)).toBe(
      template.replace("{{RELEASE_COMMIT}}", sha),
    );
  });

  it("实际当版固定正文可渲染，并保留法律材料引用与未认证边界", () => {
    const source = readFileSync(path.join(repositoryRoot, "docs/release/notes/v1.1.0.md"), "utf8");
    const body = renderControlledReleaseNotes(source, identity);
    expect(body).not.toContain("{{RELEASE_COMMIT}}");
    expect(body).toContain(`Commit: ${sha}`);
    expect(body).toContain("THIRD_PARTY_NOTICES.md");
    expect(body).toContain("外部");
    expect(body).toContain("not certified");
  });

  it.each([
    ["版本与 Tag 不符", { version: "1.0.1" }],
    ["请求 Tag 不符", { requestedTag: "v1.1.1" }],
    ["标签不存在", { tagSha: undefined }],
    ["标签指向其他提交", { tagSha: "b".repeat(40) }],
    ["HEAD 不是完整 SHA", { headSha: "abc", tagSha: "abc" }],
    ["SHA 含非法字符", { headSha: "g".repeat(40), tagSha: "g".repeat(40) }],
    ["工作区脏", { dirty: true }],
  ])("拒绝%s", (_label, change) => {
    expect(() => renderControlledReleaseNotes(template, { ...identity, ...change })).toThrow();
  });

  it.each([
    ["标题错误", template.replace("# CoreMind v1.1.0", "# CoreMind v1.0.1")],
    ["Version 行错误", template.replace("Version: 1.1.0", "Version: 1.0.1")],
    ["Tag 行错误", template.replace("Tag: v1.1.0", "Tag: v1.0.1")],
    ["缺少提交占位符", template.replace("{{RELEASE_COMMIT}}", sha)],
    ["提交占位符重复", `${template}\n{{RELEASE_COMMIT}}\n`],
    ["未知占位符", `${template}\n{{PR_TITLES}}\n`],
    ["缺少英文正文", template.slice(0, template.indexOf("Reviewed release"))],
    ["缺少中文正文", template.replace("已审阅的中文说明，保留正文内部  空格。", "")],
    ["缺少英文章节", template.replace("## English", "## Other")],
  ])("拒绝%s", (_label, source) => {
    expect(() => renderControlledReleaseNotes(source, identity)).toThrow();
  });

  it("不将未审 PR 标题或环境文字拼入固定正文", () => {
    const canary = "unreviewed-pr-title-739027";
    const unreviewedIdentity = { ...identity, prTitles: [canary] };
    const body = renderControlledReleaseNotes(template, unreviewedIdentity);
    expect(body).toBe(template.replace("{{RELEASE_COMMIT}}", sha));
    expect(body).not.toContain(canary);
  });

  it("恢复接受相同正文及 CRLF/终止换行差异", () => {
    const body = template.replace("{{RELEASE_COMMIT}}", sha);
    expect(() => assertExistingReleaseNotes(body, body)).not.toThrow();
    expect(() => assertExistingReleaseNotes(body.replaceAll("\n", "\r\n"), body)).not.toThrow();
    expect(() => assertExistingReleaseNotes(body.replace(/\n$/u, ""), body)).not.toThrow();
  });

  it.each([
    ["缺失正文", undefined],
    ["空值正文", null],
    ["非字符串正文", { body: template }],
    ["不同版本", template.replace("1.1.0", "1.0.1")],
    ["内部空格变化", template.replace("内部  空格", "内部 空格")],
    ["新增标题", `${template}\n未审 PR 标题\n`],
  ])("恢复拒绝%s", (_label, existing) => {
    expect(() => assertExistingReleaseNotes(existing, template)).toThrow();
  });
});

describe("受控发布说明 CLI 的真实 Git 身份", () => {
  it("从脚本根读取版本与 annotated Tag，在其他 cwd 生成完整中英说明", () => {
    const fixture = createFixture();
    expect(
      git(fixture.root, [
        "config",
        "--local",
        "--get-regexp",
        "^(user\\.(name|email)|core\\.autocrlf)$",
      ]).split(/\r?\n/u),
    ).toEqual([
      "user.name CoreMind Test",
      "user.email test@example.invalid",
      "core.autocrlf false",
    ]);
    const expected = template.replace("{{RELEASE_COMMIT}}", fixture.commit);
    const manifest = writeManifest(fixture.root, fixture.commit);
    const result = invoke(fixture.root, ["--manifest", manifest], tmpdir());
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.output, "utf8")).toBe(expected);
    expect(readFileSync(path.join(fixture.root, "THIRD_PARTY_NOTICES.md"), "utf8")).toBe(
      "合法第三方版权与许可材料\n",
    );
    expect(readFileSync(path.join(fixture.root, "LICENSE"), "utf8")).toBe("测试许可正文\n");
  });

  it("200 恢复比较不要求 output，接受换行差异且所有文件字节保持不变", () => {
    const fixture = createFixture();
    const manifest = writeManifest(fixture.root, fixture.commit);
    const existing = path.join(fixture.root, ".scratch", "existing.json");
    const expected = template.replace("{{RELEASE_COMMIT}}", fixture.commit);
    writeFileSync(existing, JSON.stringify({ body: expected.replaceAll("\n", "\r\n") }), "utf8");
    const before = snapshotFiles(fixture.root);
    const result = invoke(fixture.root, ["--manifest", manifest, "--existing-release", existing]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(fixture.output)).toBe(false);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });

  it.each([
    ["缺失", null],
    ["空白", "\n"],
    ["版本错误", template.replaceAll("1.1.0", "1.0.1")],
  ])("当前版本固定文件%s时失败且不回退到旧文件", (_label, source) => {
    const fixture = createFixture(source);
    const result = invoke(fixture.root);
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.output)).toBe(false);
  });

  it("拒绝真实未提交修改，失败不覆盖既有本地输出", () => {
    const fixture = createFixture();
    writeFileSync(path.join(fixture.root, "tracked.txt"), "未提交修改\n", "utf8");
    writeFileSync(fixture.output, "保留已有输出\n", "utf8");
    const result = invoke(fixture.root);
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.output, "utf8")).toBe("保留已有输出\n");
  });

  it.each(["missing", "different"])("拒绝真实 %s 标签身份", (mode) => {
    const fixture = createFixture();
    if (mode === "missing") git(fixture.root, ["tag", "-d", "v1.1.0"]);
    else {
      writeFileSync(path.join(fixture.root, "tracked.txt"), "第二个已提交版本\n", "utf8");
      git(fixture.root, ["add", "tracked.txt"]);
      git(fixture.root, ["commit", "--quiet", "--no-gpg-sign", "-m", "第二次提交"]);
    }
    const result = invoke(fixture.root);
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.output)).toBe(false);
  });

  it.each([
    { name: "未知", extra: ["--unknown", "x"] },
    { name: "重复", extra: ["--tag", "v1.1.0"] },
    { name: "manifest 缺值", extra: ["--manifest"] },
    { name: "existing-release 缺值", extra: ["--existing-release"] },
  ])("拒绝 $name CLI 参数", ({ extra }) => {
    const fixture = createFixture();
    expect(invoke(fixture.root, extra).status).not.toBe(0);
    expect(existsSync(fixture.output)).toBe(false);
  });

  it.each([
    { name: "版本", change: { version: "1.0.1" } },
    { name: "Tag", change: { tag: "v1.0.1" } },
    { name: "提交", change: { commit: "b".repeat(40) } },
    { name: "候选状态", change: { candidate: true } },
  ])("manifest 的 $name 冲突即停止", ({ change }) => {
    const fixture = createFixture();
    const manifest = writeManifest(fixture.root, fixture.commit, change);
    const result = invoke(fixture.root, ["--manifest", manifest]);
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.output)).toBe(false);
  });

  it("既有 Release 正文冲突时不覆盖 JSON 或产生可发布输出", () => {
    const fixture = createFixture();
    const manifest = writeManifest(fixture.root, fixture.commit);
    const existing = path.join(fixture.root, ".scratch", "existing.json");
    for (const body of [null, "未审阅的已有线上正文\n"]) {
      const raw = `${JSON.stringify({ body })}\n`;
      writeFileSync(existing, raw, "utf8");
      const result = invoke(fixture.root, ["--manifest", manifest, "--existing-release", existing]);
      expect(result.status).not.toBe(0);
      expect(existsSync(fixture.output)).toBe(false);
      expect(readFileSync(existing, "utf8")).toBe(raw);
    }
  });
});

function git(root: string, args: string[]) {
  const result = spawnSync(
    "git",
    ["-c", `core.hooksPath=${path.join(root, "disabled-hooks")}`, ...args],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0) throw new Error(`测试夹具 Git 失败：${result.stderr}`);
  return result.stdout.trim();
}

function createFixture(source: string | null = template) {
  const root = mkdtempSync(path.join(tmpdir(), "coremind-release-notes-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "docs", "release", "notes"), { recursive: true });
  mkdirSync(path.join(root, ".scratch"));
  for (const name of [
    "release-notes.mjs",
    "release-artifacts.mjs",
    "release-version.mjs",
    "verify-provider-certification-artifact.mjs",
    "provider-certification.mjs",
  ])
    copyFileSync(path.join(repositoryRoot, "scripts", name), path.join(root, "scripts", name));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: "1.1.0", type: "module" }),
    "utf8",
  );
  writeFileSync(path.join(root, ".gitignore"), ".scratch/\nrelease-artifacts/\n", "utf8");
  writeFileSync(path.join(root, "tracked.txt"), "首个版本\n", "utf8");
  writeFileSync(path.join(root, "LICENSE"), "测试许可正文\n", "utf8");
  writeFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "合法第三方版权与许可材料\n", "utf8");
  writeFileSync(
    path.join(root, "docs", "release", "notes", "v1.0.1.md"),
    template.replaceAll("1.1.0", "1.0.1"),
    "utf8",
  );
  if (source !== null)
    writeFileSync(path.join(root, "docs", "release", "notes", "v1.1.0.md"), source, "utf8");
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  // 固定配置直接写入自有仓库，避免每个夹具额外启动三次 Git。
  appendFileSync(
    path.join(root, ".git", "config"),
    "\n[user]\n\tname = CoreMind Test\n\temail = test@example.invalid\n[core]\n\tautocrlf = false\n",
    "utf8",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "--no-gpg-sign", "-m", "固定发布说明夹具"]);
  git(root, ["tag", "--annotate", "--no-sign", "v1.1.0", "--message", "固定发布标签"]);
  return {
    root,
    commit: git(root, ["rev-parse", "HEAD"]),
    output: path.join(root, ".scratch", "notes.md"),
  };
}

function invoke(root: string, extra: string[] = [], cwd = root) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "release-notes.mjs"),
      "--tag",
      "v1.1.0",
      ...(extra.includes("--existing-release")
        ? []
        : ["--output", path.join(root, ".scratch", "notes.md")]),
      ...extra,
    ],
    { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBeTypeOf("number");
  return result;
}

function snapshotFiles(root: string, directory = root): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory()
        ? Object.entries(snapshotFiles(root, file))
        : [[path.relative(root, file), readFileSync(file).toString("base64")]];
    }),
  );
}

function writeManifest(root: string, commit: string, change: Record<string, unknown> = {}) {
  const file = path.join(root, ".scratch", "release-manifest.json");
  writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, version: "1.1.0", tag: "v1.1.0", commit, ...change }),
    "utf8",
  );
  return file;
}

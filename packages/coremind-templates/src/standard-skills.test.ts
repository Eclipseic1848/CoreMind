import { createHash } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSkillResourcePath,
  readStandardSkillPackage,
  resolveSelectedSkills,
} from "./internal.js";
import { findSkill } from "./skills.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "coremind-selected-skills-"));
  directories.push(root);
  const configDir = path.join(root, "config");
  await mkdir(configDir);
  return { root, configDir };
}

async function writeSkill(
  configDir: string,
  id: string,
  file: string,
  content: string | Uint8Array,
) {
  const destination = path.join(configDir, "skills", id, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  return destination;
}

function source(name = "标准技能", body = "原始正文\n") {
  return `---\nname: ${name}\ndescription: 技能说明\n---\n${body}`;
}

describe("显式选择标准技能", () => {
  it("未选项目技能时不访问配置目录，保留内置重复项", async () => {
    const unavailable = path.join(tmpdir(), "不存在的配置目录", "child");
    expect(await resolveSelectedSkills([], unavailable)).toEqual({
      legacyContents: [],
      standard: [],
      missing: [],
      warnings: [],
    });
    expect(await resolveSelectedSkills(["code-review", "code-review"], unavailable)).toEqual({
      legacyContents: [findSkill("code-review")!.content, findSkill("code-review")!.content],
      standard: [],
      missing: [],
      warnings: [],
    });
  });

  it("内置优先，README 保留内置先、项目后的原顺序与安全中文 ID", async () => {
    const { configDir } = await workspace();
    await writeSkill(configDir, "中文 旧技能", "README.md", "旧技能全文\r\n");
    await writeSkill(configDir, "code-review", "SKILL.md", "损坏且不应读取");
    await writeSkill(configDir, "未选技能", "SKILL.md", "未选损坏内容");
    const resolved = await resolveSelectedSkills(
      ["中文 旧技能", "code-review", "translation", "中文 旧技能"],
      configDir,
    );
    expect(resolved).toEqual({
      legacyContents: [
        findSkill("code-review")!.content,
        findSkill("translation")!.content,
        "旧技能全文\r\n",
        "旧技能全文\r\n",
      ],
      standard: [],
      missing: [],
      warnings: [],
    });
  });

  it.each(["\n", "\r\n"])("解析中文和多行描述，正文逐字节保留换行 %j", async (newline) => {
    const { configDir } = await workspace();
    const body = "\n# 正文\r\n  保留空格\n末尾\r\n";
    const header = [
      "---",
      "name: 中文名称",
      "description: |",
      "  第一行",
      "  第二行",
      "---",
      "",
    ].join(newline);
    await writeSkill(configDir, "中文-ID", "SKILL.md", `\uFEFF${header}${body}`);
    const resolved = await resolveSelectedSkills(["中文-ID"], configDir);
    expect(resolved.standard).toEqual([
      {
        id: "中文-ID",
        name: "中文名称",
        description: "第一行\n第二行\n",
        body,
        bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
      },
    ]);
    expect(resolved.legacyContents).toEqual([]);
  });

  it("双文件只选 SKILL 并告警，重复 ID 去重、重名不产生别名", async () => {
    const { configDir } = await workspace();
    await writeSkill(configDir, "one", "SKILL.md", source("相同名称", "正文一"));
    await writeSkill(configDir, "one", "README.md", "不应进入旧正文");
    await writeSkill(configDir, "two", "SKILL.md", source("相同名称", "正文二"));
    const resolved = await resolveSelectedSkills(["one", "one", "two", "相同名称"], configDir);
    expect(resolved.standard.map((skill) => [skill.id, skill.body])).toEqual([
      ["one", "正文一"],
      ["two", "正文二"],
    ]);
    expect(resolved.legacyContents).toEqual([]);
    expect(resolved.missing).toEqual(["相同名称"]);
    expect(resolved.warnings).toHaveLength(2);
    expect(resolved.warnings.join("\n")).toContain("SKILL.md 和 README.md");
    expect(resolved.warnings.join("\n")).toContain("相同名称");
  });

  it.each([
    "没有 frontmatter",
    "---\nname: 未闭合",
    "---\n[损坏 YAML\n---\n正文",
    "---\n- 数组\n---\n正文",
    "---\nname: 123\ndescription: 说明\n---\n正文",
    "---\nname: 技能\ndescription: []\n---\n正文",
    "---\nname: ' '\ndescription: 说明\n---\n正文",
    "---\nname: 技能\ndescription: |\n  \n---\n正文",
    "---\nname: 重复\nname: 重复键\ndescription: 说明\n---\n正文",
  ])("损坏标准技能明确拒绝，不回落 README：%j", async (content) => {
    const { configDir } = await workspace();
    await writeSkill(configDir, "broken", "SKILL.md", content);
    await writeSkill(configDir, "broken", "README.md", "不能回落");
    await expect(resolveSelectedSkills(["broken"], configDir)).rejects.toThrow();
  });

  it("仅真实不存在的根、目录或文件进入 missing", async () => {
    const { configDir } = await workspace();
    expect((await resolveSelectedSkills(["missing"], configDir)).missing).toEqual(["missing"]);
    await mkdir(path.join(configDir, "skills", "empty"), { recursive: true });
    expect((await resolveSelectedSkills(["missing", "empty"], configDir)).missing).toEqual([
      "missing",
      "empty",
    ]);
    await mkdir(path.join(configDir, "skills", "not-file", "SKILL.md"), { recursive: true });
    await expect(resolveSelectedSkills(["not-file"], configDir)).rejects.toThrow("普通文件");
    await writeFile(path.join(configDir, "skills", "not-directory"), "文件", "utf8");
    await expect(resolveSelectedSkills(["not-directory"], configDir)).rejects.toThrow("不是目录");
  });

  it.each([
    "",
    ".",
    "..",
    "../outside",
    "..\\outside",
    "C:outside",
    "/outside",
    "\\\\server",
    "nul\0id",
  ])("拒绝路径型 ID：%j", async (id) => {
    const { configDir } = await workspace();
    await expect(resolveSelectedSkills([id], configDir)).rejects.toThrow("非法技能 ID");
  });

  it.each(["README.md", "SKILL.md"])("%s 的 256 KiB 源边界包含全部 UTF-8 字节", async (file) => {
    const { configDir } = await workspace();
    const header = file === "SKILL.md" ? source("边界", "") : "";
    const content = header + "x".repeat(MAX_SOURCE_BYTES - Buffer.byteLength(header, "utf8"));
    const selected = await writeSkill(configDir, "bounded", file, content);
    await expect(resolveSelectedSkills(["bounded"], configDir)).resolves.toMatchObject({
      missing: [],
    });
    await appendFile(selected, "x", "utf8");
    await expect(resolveSelectedSkills(["bounded"], configDir)).rejects.toThrow("256 KiB");
  });

  it("完整结果恰好 2 MiB 可用，超过一字节明确失败", async () => {
    const { configDir } = await workspace();
    const ids = Array.from({ length: 8 }, (_, index) => `legacy-${index}`);
    const overhead = Buffer.byteLength(
      JSON.stringify({
        legacyContents: Array(8).fill(""),
        standard: [],
        missing: [],
        warnings: [],
      }),
      "utf8",
    );
    for (const [index, id] of ids.entries()) {
      await writeSkill(
        configDir,
        id,
        "README.md",
        "x".repeat(MAX_SOURCE_BYTES - (index === 7 ? overhead : 0)),
      );
    }
    const resolved = await resolveSelectedSkills(ids, configDir);
    expect(Buffer.byteLength(JSON.stringify(resolved), "utf8")).toBe(MAX_RESULT_BYTES);
    await appendFile(path.join(configDir, "skills", ids[7]!, "README.md"), "x", "utf8");
    await expect(resolveSelectedSkills(ids, configDir)).rejects.toThrow("2 MiB");
  });

  it.each(["skills-root", "selected-directory"])("拒绝 %s 的目录链接越界", async (level) => {
    const { root, configDir } = await workspace();
    const outside = path.join(root, "outside");
    await mkdir(path.join(outside, "chosen"), { recursive: true });
    await writeFile(path.join(outside, "chosen", "SKILL.md"), source(), "utf8");
    if (level === "skills-root") {
      await symlink(outside, path.join(configDir, "skills"), "junction");
    } else {
      await mkdir(path.join(configDir, "skills"));
      await symlink(
        path.join(outside, "chosen"),
        path.join(configDir, "skills", "chosen"),
        "junction",
      );
    }
    await expect(resolveSelectedSkills(["chosen"], configDir)).rejects.toThrow("越界");
  });

  it.skipIf(process.platform === "win32")("拒绝文件链接越界和断链，允许目录内链接", async () => {
    const { root, configDir } = await workspace();
    const outside = path.join(root, "outside.md");
    await writeFile(outside, source(), "utf8");
    await mkdir(path.join(configDir, "skills", "chosen"), { recursive: true });
    const file = path.join(configDir, "skills", "chosen", "SKILL.md");
    await symlink(outside, file);
    await expect(resolveSelectedSkills(["chosen"], configDir)).rejects.toThrow("越界");
    await rm(file);
    await symlink(path.join(root, "absent.md"), file);
    await expect(resolveSelectedSkills(["chosen"], configDir)).rejects.toThrow();
    await rm(file);
    const inside = await writeSkill(configDir, "chosen", "body.md", source());
    await symlink(inside, file);
    expect((await resolveSelectedSkills(["chosen"], configDir)).standard[0]?.id).toBe("chosen");
  });

  it("无效 UTF-8 明确拒绝", async () => {
    const { configDir } = await workspace();
    await writeSkill(configDir, "invalid-encoding", "README.md", Uint8Array.of(0xff));
    await expect(resolveSelectedSkills(["invalid-encoding"], configDir)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "读取权限错误不能伪装为缺失",
    async () => {
      const { configDir } = await workspace();
      const file = await writeSkill(configDir, "denied", "README.md", "正文");
      await chmod(file, 0);
      await expect(resolveSelectedSkills(["denied"], configDir)).rejects.toMatchObject({
        code: "EACCES",
      });
    },
  );

  it.each(["open", "after-read"] as const)("%s 时源内容变化必须拒绝", async (phase) => {
    const { configDir } = await workspace();
    const file = await writeSkill(configDir, "changing", "SKILL.md", source());
    const { open: realOpen } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (phase === "open") await appendFile(file, "变化", "utf8");
      else {
        const realStat = handle.stat.bind(handle);
        let calls = 0;
        vi.spyOn(handle, "stat").mockImplementation(async (options) => {
          if (++calls === 2) await appendFile(file, "变化", "utf8");
          return realStat(options);
        });
      }
      return handle;
    });
    try {
      await expect(resolveSelectedSkills(["changing"], configDir)).rejects.toThrow("变化");
    } finally {
      vi.mocked(fileSystem.open).mockImplementation(realOpen);
    }
  });

  it("返回后源文件变化不改已解析正文，后续独立解析获得新身份", async () => {
    const { configDir } = await workspace();
    const file = await writeSkill(configDir, "frozen", "SKILL.md", source("冻结", "旧正文"));
    const first = await resolveSelectedSkills(["frozen"], configDir);
    await writeFile(file, source("冻结", "新正文"), "utf8");
    const second = await resolveSelectedSkills(["frozen"], configDir);
    expect(first.standard[0]?.body).toBe("旧正文");
    expect(second.standard[0]?.body).toBe("新正文");
    expect(first.standard[0]?.bodySha256).not.toBe(second.standard[0]?.bodySha256);
  });
});

const PACKAGE_ID = "packaged";
const MANIFEST = "coremind.skill.json";
const versionedSource =
  "\uFEFF---\r\nname: 技能包\r\ndescription: 技能说明\r\nmetadata:\r\n  version: '1.2.0'\r\n---\r\n正文\r\n";

function digest(content: string | Uint8Array) {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha256").update(bytes).digest("hex");
}

async function writePackage(
  configDir: string,
  resources: { path: string; sha256: string }[],
  skillSource = versionedSource,
) {
  await writeSkill(configDir, PACKAGE_ID, "SKILL.md", skillSource);
  return writeSkill(
    configDir,
    PACKAGE_ID,
    MANIFEST,
    JSON.stringify({ schemaVersion: 1, resources }),
  );
}

describe("技能资源清单", () => {
  it("安装和运行复用同一包校验，保留原始 UTF-8 字节且只返回声明资源", async () => {
    const { configDir } = await workspace();
    const resources = [
      { path: "assets/subdir/Template.md", content: "\uFEFF模板\r\n第二行\n" },
      { path: "references/notes.md", content: "参考内容\n" },
      { path: "scripts/source.mjs", content: "// 脚本内容\n" },
    ].map(({ path, content }) => ({ path, content, sha256: digest(content) }));
    const file = await writePackage(
      configDir,
      resources.map(({ path, sha256 }) => ({ path, sha256 })),
    );
    for (const resource of resources) {
      await writeSkill(configDir, PACKAGE_ID, resource.path, resource.content);
    }
    await writeSkill(configDir, PACKAGE_ID, "assets/unlisted.md", "未声明的内容");

    const manifest = `\uFEFF${await fileSystem.readFile(file, "utf8")}\r\n`;
    await writeFile(file, manifest, "utf8");
    const loaded = await readStandardSkillPackage(path.dirname(file), PACKAGE_ID);
    expect(loaded).toEqual({
      source: versionedSource,
      manifest,
      skill: {
        id: PACKAGE_ID,
        name: "技能包",
        description: "技能说明",
        body: "正文\r\n",
        bodySha256: digest("正文\r\n"),
        packageVersion: "1.2.0",
        resources,
      },
    });
    expect((await resolveSelectedSkills([PACKAGE_ID, PACKAGE_ID], configDir)).standard).toEqual([
      loaded.skill,
    ]);
  });

  it("无清单的 Skill 可含版本元数据，旧版加载结果保持原结构", async () => {
    const { configDir } = await workspace();
    await writeSkill(configDir, PACKAGE_ID, "SKILL.md", versionedSource);
    expect((await resolveSelectedSkills([PACKAGE_ID], configDir)).standard).toEqual([
      {
        id: PACKAGE_ID,
        name: "技能包",
        description: "技能说明",
        body: "正文\r\n",
        bodySha256: digest("正文\r\n"),
      },
    ]);
  });

  it.each([
    source(),
    versionedSource.replace("'1.2.0'", "1"),
    versionedSource.replace("'1.2.0'", "' 1.2.0'"),
  ])("清单要求明确的字符串版本", async (skillSource) => {
    const { configDir } = await workspace();
    await writePackage(configDir, [], skillSource);
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toThrow(
      "metadata.version",
    );
  });

  it("声明清单缺少 SKILL.md 时报告包结构错误", async () => {
    const { configDir } = await workspace();
    await writeSkill(configDir, PACKAGE_ID, MANIFEST, '{"schemaVersion":1,"resources":[]}');
    await writeSkill(configDir, PACKAGE_ID, "README.md", "旧版说明");
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toThrow("缺少 SKILL.md");
  });

  it.each([
    "schemaVersion: 1\nresources: []\n",
    '{"schemaVersion":2,"resources":[]}',
    '{"schemaVersion":1,"resources":{}}',
    '{"schemaVersion":1,"resources":[],"unknown":true}',
    '{"schemaVersion":1,"resources":[],"resources":[]}',
    '{"schemaVersion":1,"resources":[{"path":"assets/a.md","sha256":"xyz"}]}',
  ])("拒绝不符合清单结构的输入 %j", async (manifest) => {
    const { configDir } = await workspace();
    await writeSkill(configDir, PACKAGE_ID, "SKILL.md", versionedSource);
    await writeSkill(configDir, PACKAGE_ID, MANIFEST, manifest);
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toThrow(MANIFEST);
  });

  it.each([
    "assets",
    "assets/",
    "assets/./file.md",
    "assets/../file.md",
    "assets//file.md",
    "assets/file.md.",
    "assets/File Name.md",
    "assets/FILE~1.MD",
    "assets/CON.md",
    "assets/LPT1/file.md",
    "assets/file.md\n",
    "assets/file.md:stream",
    "references\\notes.md",
    "/assets/file.md",
    "D:/assets/file.md",
    "docs/findings.md",
  ])("拒绝有别名或不可移植的资源路径 %j", (resource) => {
    expect(isSkillResourcePath(resource)).toBe(false);
  });

  it.each([
    ["assets/theme.md", "assets/theme.md"],
    ["assets/theme.md", "assets/Theme.md"],
    ["assets/Blue/one.md", "assets/blue/two.md"],
    ["assets/blue", "assets/blue/two.md"],
  ])("在访问资源之前拒绝冲突路径 %s 和 %s", async (first, second) => {
    const { configDir } = await workspace();
    await writePackage(
      configDir,
      [first, second].map((path) => ({ path, sha256: digest("") })),
    );
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toThrow("重复或冲突");
  });

  it("报告缺失、摘要异常和无效 UTF-8 的声明资源", async () => {
    const { configDir } = await workspace();
    const resource = "assets/template.md";
    await writePackage(configDir, [{ path: resource, sha256: digest("原文\n") }]);
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeSkill(configDir, PACKAGE_ID, resource, "原文\r\n");
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toThrow(
      /SHA-256.*assets\/template\.md/u,
    );
    const invalidUtf8 = Uint8Array.of(0xff);
    await writePackage(configDir, [{ path: resource, sha256: digest(invalidUtf8) }]);
    await writeSkill(configDir, PACKAGE_ID, resource, invalidUtf8);
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toThrow("utf-8");
  });

  it("拒绝指向包内的资源目录联接和其他目录链接", async () => {
    const { configDir } = await workspace();
    const link = "assets/linked";
    const resource = "sample.md";
    await writePackage(configDir, [{ path: `${link}/${resource}`, sha256: digest("正文") }]);
    const target = await writeSkill(configDir, PACKAGE_ID, `assets/original/${resource}`, "正文");
    await symlink(
      path.dirname(target),
      path.join(configDir, "skills", PACKAGE_ID, link),
      "junction",
    );
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toThrow(/链接.*linked/u);
  });

  it.skipIf(process.platform === "win32")("拒绝指向包内的声明资源文件链接", async () => {
    const { configDir } = await workspace();
    const resource = "assets/linked.md";
    await writePackage(configDir, [{ path: resource, sha256: digest("正文") }]);
    const target = await writeSkill(configDir, PACKAGE_ID, "assets/original.md", "正文");
    await symlink(target, path.join(configDir, "skills", PACKAGE_ID, resource));
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toThrow(
      /链接.*linked\.md/u,
    );
  });

  it("逐项限制资源文件及整个解析结果的字节数", async () => {
    const { configDir } = await workspace();
    const content = "a".repeat(MAX_SOURCE_BYTES);
    const resources = Array.from({ length: 9 }, (_, index) => ({
      path: `assets/file-${index}.md`,
      sha256: digest(content),
    }));
    await writePackage(configDir, resources);
    for (const resource of resources.slice(0, 8)) {
      await writeSkill(configDir, PACKAGE_ID, resource.path, content);
    }
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toThrow(
      /2 MiB.*file-7\.md/u,
    );
    const first = resources[0]!;
    await writeSkill(configDir, PACKAGE_ID, first.path, `${content}x`);
    await expect(resolveSelectedSkills([PACKAGE_ID], configDir)).rejects.toThrow(
      /256 KiB.*file-0\.md/u,
    );
  });
});

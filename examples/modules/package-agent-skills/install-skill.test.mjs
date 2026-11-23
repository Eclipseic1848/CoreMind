import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installSkill } from "./install-skill.mjs";

const id = "fixture-shared-procedure";
const source = "example/skills-fixture";
const base = `skills/${id}`;
const template = "assets/template.md";
const lockName = "skills-lock.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("固定包可冻结重装、拒绝损坏并回退到上一个版本", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coremind-installer-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliPackage = path.join(root, "package.json");
  const configA = path.join(root, "consumer-a");
  const configB = path.join(root, "consumer-b");
  const target = path.join(configA, base);
  const lockV1 = path.join(root, "v1.skills-lock.json");
  const lockV2 = path.join(root, "v2.skills-lock.json");
  const marker = path.join(root, "executed");
  const releases = new Map();
  await mkdir(configA);
  await mkdir(configB);
  await writeFile(cliPackage, JSON.stringify({ name: "skills", version: "1.9.0" }), "utf8");

  for (const version of ["1", "2"]) {
    const folder = path.join(root, `source-${version}`);
    const commit = version.repeat(40);
    const resources = {
      [template]: `\uFEFF模板 ${version}\r\n`,
      "scripts/sentinel.mjs": `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed', 'utf8');\n`,
    };
    const files = {
      "SKILL.md": `---\nname: ${id}\ndescription: 校验共享流程。\nmetadata:\n  version: "${version}"\n---\n\n按需读取资源。\n`,
      "coremind.skill.json": JSON.stringify({
        schemaVersion: 1,
        resources: Object.entries(resources).map(([path, content]) => ({
          path,
          sha256: sha256(content),
        })),
      }),
      ...resources,
      "assets/undeclared.txt": "不随项目包安装\n",
    };
    for (const [relative, bytes] of Object.entries(files)) {
      const file = path.join(folder, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, "utf8");
    }
    const tree = Object.entries(files)
      .map(([relative, bytes]) => {
        const blob = createHash("sha1")
          .update(`blob ${Buffer.byteLength(bytes, "utf8")}\0${bytes}`)
          .digest("hex");
        return `100644 blob ${blob}\t${base}/${relative}\0`;
      })
      .join("");
    const lock = JSON.stringify({
      version: 2,
      skills: {
        [id]: {
          source,
          ref: commit,
          commit,
          sourceType: "github",
          skillPath: `${base}/SKILL.md`,
          computedHash: sha256(tree),
          installMode: "copy",
        },
      },
    });
    releases.set(commit, { folder, tree, lock, files });
  }

  let fault;
  const transport = async (command, args, { cwd }) => {
    if (command === process.execPath) {
      assert.equal(args[0], path.join(root, "bin", "cli.mjs"));
      if (args[1] === "add") {
        assert.deepEqual(args.slice(3), ["--skill", id, "--agent", "codex", "--copy", "--yes"]);
        const release = releases.get(args[2].split("@")[1]);
        await writeFile(path.join(cwd, lockName), release.lock, "utf8");
      } else {
        assert.deepEqual(args.slice(1), ["install", "--frozen-lockfile", "--agent", "codex"]);
        const lockFile = path.join(cwd, lockName);
        const lock = await readFile(lockFile, "utf8");
        const { commit } = JSON.parse(lock).skills[id];
        const release = releases.get(commit);
        assert.equal(lock, release.lock);
        const skill = path.join(cwd, ".agents", base);
        await cp(release.folder, skill, { recursive: true });
        if (fault === "resource") await writeFile(path.join(skill, template), "篡改", "utf8");
        if (fault === "lock") await writeFile(lockFile, `${lock}\n`, "utf8");
      }
      return {};
    }
    assert.equal(command, "git");
    if (args[2] === "ls-tree") {
      const tree = releases.get(args[5]).tree;
      return {
        stdout:
          fault === "link"
            ? tree.replace(
                /100644(?= blob [a-f0-9]+\tskills\/fixture-shared-procedure\/assets\/template\.md)/u,
                "120000",
              )
            : tree,
      };
    }
    assert.ok(args[0] === "init" || args[2] === "fetch");
    return {};
  };
  const install = (project, lock, commit) =>
    installSkill(project, id, cliPackage, lock, commit && `${source}@${commit}`, transport);
  const v1 = "1".repeat(40);
  const v2 = "2".repeat(40);
  const initial = await install(configA, lockV1, v1);
  const frozen = await install(configB, lockV1);
  assert.deepEqual(initial, frozen);
  assert.equal(initial.lockSha256, sha256(await readFile(lockV1)));
  const declared = Object.entries(releases.get(v1).files).filter(
    ([relative]) => !relative.endsWith("undeclared.txt"),
  );
  for (const [relative, original] of declared) {
    assert.equal(await readFile(path.join(target, relative), "utf8"), original);
    assert.deepEqual(
      await readFile(path.join(configB, base, relative)),
      Buffer.from(original, "utf8"),
    );
  }
  assert.deepEqual(await readdir(path.join(target, "assets")), ["template.md"]);
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });

  for (const [problem, expected] of [
    ["lock", /冻结安装改写/],
    ["resource", /SHA-256 不匹配/],
    ["link", /固定提交中的文件类型或原始字节不匹配/],
  ]) {
    fault = problem;
    await assert.rejects(install(configA, lockV2, v2), expected);
    assert.equal(
      await readFile(path.join(target, template), "utf8"),
      releases.get(v1).files[template],
    );
    await assert.rejects(readFile(lockV2, "utf8"), { code: "ENOENT" });
  }
  fault = undefined;
  const staging = path.join(path.dirname(target), `.${id}.install`);
  const originalRename = fs.rename;
  const rename = t.mock.method(fs, "rename", (from, to) => {
    if (from === path.join(staging, "next")) throw new Error("模拟目录替换失败");
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(install(configA, lockV2, v2), /模拟目录替换失败/);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(
    await readFile(path.join(target, template), "utf8"),
    releases.get(v1).files[template],
  );
  assert.equal(await readFile(lockV2, "utf8"), releases.get(v2).lock);
  assert.equal((await install(configA, lockV2)).version, "2");
  assert.equal(
    await readFile(path.join(target, template), "utf8"),
    releases.get(v2).files[template],
  );
  assert.deepEqual(await install(configA, lockV1), initial);
  assert.equal(
    await readFile(path.join(target, template), "utf8"),
    releases.get(v1).files[template],
  );
  assert.deepEqual(await readdir(path.dirname(target)), [id]);
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
});

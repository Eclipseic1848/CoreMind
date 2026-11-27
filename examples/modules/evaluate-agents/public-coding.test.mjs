import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codingToolPolicy,
  runOriginalCodingEvaluation,
  summarizePublicCodingHistory,
} from "./public-coding.mjs";
import { publicProvider } from "./public-provider.mjs";

const attempt = { attempt: 1, passed: true, outcome: { status: "succeeded" } };
const receipt = {
  runsPerProfile: 1,
  provider: { id: publicProvider.id, model: publicProvider.model, baseUrl: publicProvider.baseUrl },
  profiles: { python: { attempts: [attempt] }, typescript: { attempts: [attempt] } },
};

test("模型可检查夹具测试和 Git，只能修改目标源码并执行指定测试命令", () => {
  const profile = { source: "src/price.ts", commands: ["node --test"] };
  const denied = [];
  const policy = codingToolPolicy(
    process.cwd(),
    profile,
    new Set(["src/price.ts", "tests/price.ts"]),
    denied,
  );
  const check = (tool, args) =>
    policy.extensions[0].handlers["before-tool"]({ payload: { tool, args } });
  assert.equal(check("read", { path: "tests/price.ts" }), undefined);
  assert.equal(check("git_diff", {}), undefined);
  assert.equal(check("edit", { path: "src/price.ts" }), undefined);
  assert.equal(check("bash", { command: "node --test" }), undefined);
  assert.ok(check("edit", { path: "tests/price.ts" }).deny);
  assert.ok(check("read", { path: "user-notes.txt" }).deny);
  assert.ok(check("bash", { command: "node --version" }).deny);
  assert.deepEqual(
    denied.map(({ tool, scope }) => [tool, scope]),
    [
      ["edit", "tests"],
      ["read", "other"],
      ["bash", "no-path"],
    ],
  );
});

test("历史回执需要同一公网模型、完整语言及每种一次执行", () => {
  assert.equal(summarizePublicCodingHistory(receipt).length, 2);
  for (const input of [
    { ...receipt, profiles: {} },
    { ...receipt, profiles: { python: receipt.profiles.python } },
    { ...receipt, profiles: { ...receipt.profiles, python: { attempts: [] } } },
    { ...receipt, provider: { ...receipt.provider, model: "other" } },
    { ...receipt, runsPerProfile: 2 },
  ])
    assert.throws(() => summarizePublicCodingHistory(input));
});

test("历史子进程早退不会重读旧回执，写出有效失败时仍保留失败", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coremind-coding-receipt-"));
  const target = path.join(dir, "coding-history.attempt1.json");
  const exitOne = () => {
    throw Object.assign(new Error("测试子进程返回非零"), { code: 1 });
  };
  try {
    await writeFile(target, JSON.stringify(receipt), "utf8");
    await assert.rejects(runOriginalCodingEvaluation(dir, "all", exitOne), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), receipt);
    const failed = structuredClone(receipt);
    failed.profiles.python.attempts[0] = {
      attempt: 1,
      passed: false,
      outcome: { status: "failed" },
    };
    const rows = await runOriginalCodingEvaluation(dir, "all", async (_node, args) => {
      await writeFile(args.at(-1), JSON.stringify(failed), "utf8");
      exitOne();
    });
    assert.equal(rows.find((row) => row.language === "python").passed, false);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), failed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

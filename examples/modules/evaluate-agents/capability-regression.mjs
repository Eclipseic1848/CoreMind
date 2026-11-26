import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

const { values } = parseArgs({ options: { output: { type: "string" } } });
const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const python = process.env.COREMIND_ONTOLOGY_PYTHON ?? "python";
const temporaryRoot = await realpath(tmpdir());
const temporary = await mkdtemp(path.join(temporaryRoot, "coremind-capability-eval-"));
const knowledge = path.join(temporary, "knowledge.json");
const skill = path.join(temporary, "skill.json");
const commands = [
  {
    name: "knowledge",
    program: python,
    args: [
      "-B",
      "-X",
      "utf8",
      "examples/knowledge-evals/zh-retrieval/answer_benchmark.py",
      "--replay",
      "--output",
      knowledge,
    ],
    file: knowledge,
  },
  {
    name: "memory",
    program: python,
    args: ["-B", "-X", "utf8", "examples/modules/manage-memory/effect_evaluation.py"],
  },
  {
    name: "skill",
    program: process.execPath,
    args: ["examples/modules/package-agent-skills/paired-evaluation.mjs", "--offline", skill],
    file: skill,
  },
  {
    name: "tools",
    program: process.execPath,
    args: ["examples/modules/build-tools/transport-parity.mjs"],
    ndjson: true,
  },
  {
    name: "ontology",
    program: process.execPath,
    args: ["examples/modules/manage-ontology/acceptance.mjs"],
    ndjson: true,
  },
];

const domains = {};
let cleanupError;
try {
  for (const { name, program, args, file, ndjson } of commands) {
    let contents;
    try {
      const { stdout } = await execute(program, args, {
        cwd: root,
        env: { ...process.env, PYTHONUTF8: "1" },
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      contents = file ? await readFile(file, "utf8") : stdout.trim();
      const evidence = ndjson ? contents.split("\n").map(JSON.parse) : JSON.parse(contents);
      domains[name] = { passed: true, evidence };
    } catch (error) {
      // 保留子评测失败前已写入的可读回执，并继续执行其他域。
      contents ??= file ? await readFile(file, "utf8").catch(() => undefined) : error.stdout;
      domains[name] = {
        passed: false,
        error: (error.stderr?.trim() || error.message).slice(-4000),
        ...(contents?.trim() && { partialEvidence: contents.trim() }),
      };
    }
  }
} finally {
  try {
    const resolved = await realpath(temporary);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert(path.basename(resolved).startsWith("coremind-capability-eval-"));
    await rm(resolved, { recursive: true });
  } catch (error) {
    cleanupError = error.message;
  }
}

const passed = !cleanupError && Object.values(domains).every((domain) => domain.passed);
const report = { schemaVersion: 1, mode: "offline", passed, domains, cleanupError };
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (values.output) {
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, serialized, "utf8");
  console.log(
    JSON.stringify({
      passed,
      domains: Object.fromEntries(
        Object.entries(domains).map(([name, domain]) => [name, domain.passed]),
      ),
    }),
  );
} else {
  process.stdout.write(serialized);
}
if (!passed) process.exitCode = 1;

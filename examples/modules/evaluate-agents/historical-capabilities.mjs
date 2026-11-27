import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { startLocalPython } from "../manage-ontology/ontology-fixture.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const retrieval = "examples/knowledge-evals/zh-retrieval";
const modules = "examples/modules";
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

// 本地日志只读。统计首尾与耗时，不将用户文本、工具输出或外部凭据写入报告。
async function inventoryLogs() {
  const directory = path.join(root, ".coremind/runs");
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return { available: false, files: 0 };
    throw error;
  }
  const facts = Object.create(null);
  const statusCounts = Object.create(null);
  const configNames = Object.create(null);
  const configStatus = Object.create(null);
  const startFieldCounts = { hasInitialPrompt: 0, hasInlineConfig: 0, hasConfigFingerprint: 0 };
  const durations = [];
  let unreadableFiles = 0;
  for (const name of names) {
    let rows;
    try {
      const contents = await readFile(path.join(directory, name), "utf8");
      rows = contents
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .map(JSON.parse);
    } catch {
      unreadableFiles++;
      continue;
    }
    for (const { kind } of rows) increment(facts, kind);
    const start = rows.find((row) => row.kind === "start");
    const finish = rows.findLast((row) => row.kind === "finish");
    const status = finish?.payload?.outcome?.status ?? "no-finish";
    const config = start?.payload?.configName ?? "no-start";
    increment(statusCounts, status);
    increment(configNames, config);
    configStatus[config] ??= Object.create(null);
    increment(configStatus[config], status);
    const payload = start?.payload ?? {};
    startFieldCounts.hasInitialPrompt += Number(Object.hasOwn(payload, "initialPrompt"));
    startFieldCounts.hasInlineConfig += Number(Object.hasOwn(payload, "config"));
    startFieldCounts.hasConfigFingerprint += Number(Object.hasOwn(payload, "configFingerprint"));
    if (start && finish) {
      const elapsed = Date.parse(finish.timestamp) - Date.parse(start.timestamp);
      if (Number.isFinite(elapsed)) durations.push(elapsed);
    }
  }
  durations.sort((a, b) => a - b);
  const count = durations.length;
  return {
    available: true,
    files: names.length,
    unreadableFiles,
    facts,
    recordCount: Object.values(facts).reduce((sum, n) => sum + n, 0),
    statusCounts,
    configNames,
    configStatus,
    startFieldCounts,
    wallTimeMs: {
      runs: count,
      min: durations[0] ?? null,
      max: durations.at(-1) ?? null,
      median: count
        ? (durations[Math.floor((count - 1) / 2)] + durations[Math.floor(count / 2)]) / 2
        : null,
      sum: durations.reduce((sum, n) => sum + n, 0),
    },
  };
}

export async function runHistoricalCapabilities(outputDir) {
  const directory = path.join(path.resolve(outputDir), "capability-history");
  await mkdir(directory, { recursive: true });
  const runLogInventory = await inventoryLogs();
  await writeJson(path.join(directory, "run-log-inventory.json"), runLogInventory);
  const python = process.env.COREMIND_ONTOLOGY_PYTHON || "python";
  const qdrant = process.env.COREMIND_RETRIEVAL_PYTHON || python;
  const docling = process.env.COREMIND_DOCLING_PYTHON || python;
  const model = process.env.COREMIND_RETRIEVAL_MODEL_DIR;
  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONPATH: path.join(root, "python/src"),
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    COREMIND_ONTOLOGY_PYTHON: python,
    COREMIND_SKILL_PYTHON: process.env.COREMIND_SKILL_PYTHON || python,
  };
  const options = {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 450_000,
    maxBuffer: 16 * 1024 * 1024,
  };
  const node =
    (file, ...args) =>
    () =>
      execute(process.execPath, [file, ...args], options);
  const py =
    (program, ...args) =>
    () =>
      execute(program, ["-B", "-X", "utf8", ...args], options);
  const unit = (program, source, pattern) =>
    py(program, "-m", "unittest", "discover", "-s", source, "-p", pattern);
  const result = (id) => path.join(directory, `${id}.json`);
  const vector = (id, file, ...args) => [
    id,
    py(qdrant, `${retrieval}/${file}`, ...args, "--model-dir", model, "--output", result(id)),
    true,
  ];
  async function knowledgeEntries() {
    const serviceEnv = {
      ...env,
      COREMIND_KNOWLEDGE_AUTHORIZATION: `Bearer ${randomUUID()}`,
      COREMIND_KNOWLEDGE_PYTHON: process.env.COREMIND_KNOWLEDGE_PYTHON || python,
    };
    const service = await startLocalPython(
      ["-B", "-X", "utf8", `${modules}/manage-knowledge/knowledge_server.py`, "--model-dir", model],
      { python: qdrant, cwd: root, env: serviceEnv, startupTimeoutMs: 90_000 },
    );
    try {
      return await execute(process.execPath, [`${modules}/manage-knowledge/acceptance.mjs`], {
        ...options,
        env: serviceEnv,
      });
    } finally {
      await service.close();
    }
  }
  const commands = [
    [
      "five-domains",
      node(
        `${modules}/evaluate-agents/capability-regression.mjs`,
        "--output",
        result("five-domains"),
      ),
    ],
    ["corpus-layout", node(`${retrieval}/check.mjs`)],
    ["keyword", py(python, `${retrieval}/keyword_baseline.py`)],
    vector("qdrant", "qdrant_benchmark.py"),
    vector("qdrant-persistent", "persistent_qdrant_benchmark.py"),
    vector("qdrant-answer", "answer_benchmark.py", "--replay"),
    [
      "organize-materials",
      py(
        qdrant,
        `${modules}/evaluate-agents/historical-materials.py`,
        "--model-dir",
        model,
        "--output",
        result("organize-materials"),
      ),
      true,
    ],
    ["knowledge-entries", knowledgeEntries, true],
    ["retrieval-core-unit", unit(python, retrieval, "test_answer_benchmark.py")],
    ["retrieval-keyword-unit", unit(python, retrieval, "test_keyword_baseline.py")],
    ["docling-unit", unit(docling, retrieval, "test_docling_bridge.py")],
    ["knowledge-unit", unit(qdrant, `${modules}/manage-knowledge`, "test_*.py")],
    ["ontology-unit", unit(python, `${modules}/manage-ontology`, "test_*.py")],
    ["memory-unit", unit(python, `${modules}/manage-memory`, "test_*.py")],
    [
      "memory-review",
      py(
        python,
        `${modules}/manage-memory/review_evaluation.py`,
        "--output",
        result("memory-review"),
      ),
    ],
    [
      "write-receipts",
      node(`${modules}/build-tools/write-receipts.mjs`, "--output", result("write-receipts")),
    ],
    ["skill-acceptance", node(`${modules}/package-agent-skills/acceptance.mjs`)],
    [
      "skill-unit",
      node(
        "--test",
        `${modules}/package-agent-skills/draft-skill.test.mjs`,
        `${modules}/package-agent-skills/install-skill.test.mjs`,
      ),
    ],
    ["composition", node(`${modules}/manage-ontology/composition.mjs`)],
    ["host-verification", node("examples/host-verification/demo.mjs")],
  ];
  const checks = [];
  // 固定端口的历史示例串行运行，避免把端口竞争算入评测结果。
  for (const [id, run, needsModel] of commands) {
    const start = performance.now();
    let exitCode = 0,
      stdout = "",
      stderr = "";
    try {
      if (needsModel && !model)
        throw new Error("缺少 COREMIND_RETRIEVAL_MODEL_DIR（本地 BGE-M3 模型目录）");
      ({ stdout, stderr } = await run());
    } catch (error) {
      exitCode = Number.isInteger(error.code) ? error.code : 1;
      stdout = error.stdout || "";
      stderr = error.stderr || error.message;
    }
    const check = { id, exitCode, durationMs: Math.round(performance.now() - start) };
    await Promise.all([
      writeFile(path.join(directory, `${id}.stdout.txt`), stdout, "utf8"),
      writeFile(path.join(directory, `${id}.stderr.txt`), stderr, "utf8"),
      writeJson(path.join(directory, `${id}.run.json`), check),
    ]);
    checks.push(check);
  }
  const report = {
    passed: checks.every((check) => check.exitCode === 0),
    checks,
    runLogInventory,
    environment: {
      COREMIND_ONTOLOGY_PYTHON: "五域共用 Python，含记忆、本体与知识示例依赖，默认 python",
      COREMIND_RETRIEVAL_PYTHON: "含 Qdrant 与 ONNX Runtime 的 Python，默认同五域",
      COREMIND_DOCLING_PYTHON: "含 documents 扩展与本地解析模型的 Python，默认同五域",
      COREMIND_RETRIEVAL_MODEL_DIR: "BGE-M3 固定版本的本地权重、tokenizer 所在目录",
      COREMIND_SKILL_PYTHON: "Skill 的 Python SDK 入口，默认同五域",
      COREMIND_KNOWLEDGE_PYTHON: "知识四入口脚本的 Python SDK 解释器，默认同五域",
    },
  };
  await writeJson(path.join(directory, "summary.json"), report);
  return report;
}

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { publicProvider } from "./public-provider.mjs";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "20261126" },
    output: { type: "string", default: ".scratch/generalization-eval" },
    only: { type: "string", default: "all" },
    public: { type: "boolean", default: false },
  },
});
const seed = Number(values.seed);
const suites = ["capabilities", "history", "durable", "workflow", "business", "retrieval"];
const publicSuites = ["public-knowledge", "public-business", "public-coding"];
if (values.public || publicSuites.includes(values.only)) suites.push(...publicSuites);
if (
  !Number.isSafeInteger(seed) ||
  seed < 0 ||
  (values.only !== "all" && !suites.includes(values.only))
) {
  throw new Error("seed 需要非负安全整数；only 需要合法套件名称");
}
const root = path.resolve(import.meta.dirname, "../../..");
const outputRoot = path.resolve(root, values.output);
const output = values.only === "all" ? outputRoot : path.join(outputRoot, `only-${values.only}`);
const execute = promisify(execFile);
const json = (filename, value) =>
  writeFile(path.join(output, filename), `${JSON.stringify(value, null, 2)}\n`, "utf8");
await mkdir(output, { recursive: true });

async function runHistory() {
  const env = {
    ...process.env,
    PYTHONPATH: [path.join(root, "python/src"), process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter),
    PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    COREMIND_WORKER_PATH: path.join(root, "packages/coremind-worker/dist/stdio.js"),
    REAL_LLM_TEST: "0",
  };
  const python = process.env.COREMIND_ONTOLOGY_PYTHON ?? "python";
  const runtimeDir = "packages/coremind-runtime/src";
  const taskTests = (await readdir(path.join(root, runtimeDir)))
    .filter((name) => /^task-.*\.test\.ts$/u.test(name))
    .sort()
    .map((name) => `${runtimeDir}/${name}`);
  const checks = [];
  async function check(id, command, args, vitest = false) {
    const startedAt = Date.now();
    const started = performance.now();
    const file = path.join(output, `${id}.vitest.json`);
    let exitCode = 0;
    let log;
    try {
      const result = await execute(
        command,
        vitest ? [...args, "--reporter=json", `--outputFile=${file}`] : args,
        { cwd: root, env, encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
      );
      log = result.stdout + result.stderr;
    } catch (error) {
      exitCode = error.code ?? 1;
      log = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n");
    }
    await writeFile(path.join(output, `${id}.log`), log, "utf8");
    const check = { id, exitCode, durationMs: Math.round(performance.now() - started) };
    if (vitest && (await stat(file).catch(() => null))?.mtimeMs >= startedAt - 1) {
      const result = JSON.parse(await readFile(file, "utf8"));
      Object.assign(check, {
        tests: result.numTotalTests,
        passed: result.numPassedTests,
        skipped: result.numPendingTests,
        failures: result.testResults.flatMap((item) =>
          item.assertionResults
            .filter((test) => test.status === "failed")
            .map((test) => test.fullName),
        ),
      });
      if (!check.tests || check.tests !== check.passed) check.exitCode = 1;
    } else if (vitest) {
      check.exitCode = 1;
      check.error = "Vitest 未生成当次回执";
    }
    checks.push(check);
  }
  const vitest = ["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1"];
  await check(
    "historical-node",
    process.execPath,
    [...vitest, "--project=golden-examples", "--project=coding-evals"],
    true,
  );
  await check("durable-tests", process.execPath, [...vitest, ...taskTests], true);
  await check("sales", python, [
    "-B",
    "-X",
    "utf8",
    "-m",
    "unittest",
    "discover",
    "-s",
    "examples/golden/python-data-analysis/tests",
    "-p",
    "test_*.py",
    "-v",
  ]);
  for (const kind of ["commit", "phases", "sleep", "calls", "restart"]) {
    await check(`task-${kind}`, process.execPath, [
      `examples/modules/recover-durable-runs/task-${kind}.mjs`,
    ]);
  }
  await check("python-tasks", python, [
    "-B",
    "-X",
    "utf8",
    "examples/modules/embed-coremind-python/tasks.py",
  ]);
  const { runHistoricalSales } = await import("./business-generalization.mjs");
  const sales = await runHistoricalSales();
  await json("golden-python-scenario.json", sales);
  checks.push({ id: "sales-yaml", exitCode: sales.passed ? 0 : 1, durationMs: sales.durationMs });
  return { passed: checks.every((row) => row.exitCode === 0), checks };
}

const selected = values.only === "all" ? suites : [values.only];
const report = { seed, requested: selected, passed: true, suites: {}, types: {} };
const ids = new Set();
for (const suite of selected) {
  const start = performance.now();
  try {
    if (suite === "history") report.suites[suite] = await runHistory();
    else if (suite === "public-knowledge") {
      const model = process.env.COREMIND_RETRIEVAL_MODEL_DIR;
      if (!model) throw new Error("缺少本地检索模型 COREMIND_RETRIEVAL_MODEL_DIR");
      if (!process.env[publicProvider.apiKeyEnv])
        throw new Error(`缺少 ${publicProvider.apiKeyEnv}`);
      const file = path.join(output, "public-knowledge.json");
      const python =
        process.env.COREMIND_RETRIEVAL_PYTHON || process.env.COREMIND_ONTOLOGY_PYTHON || "python";
      await execute(
        python,
        [
          "-B",
          "-X",
          "utf8",
          "examples/knowledge-evals/zh-retrieval/answer_benchmark.py",
          "--provider",
          "dashscope",
          "--model",
          publicProvider.model,
          "--model-dir",
          model,
          "--output",
          file,
        ],
        { cwd: root, encoding: "utf8", timeout: 3600000 },
      );
      const actual = JSON.parse(await readFile(file, "utf8"));
      const total = actual.cases.length;
      report.suites[suite] = {
        total,
        success: actual.taskPasses,
        guarded: actual.guardedPasses,
        model: actual.model,
        provider: actual.provider,
        passed: total > 0 && actual.taskPasses === total,
      };
    } else if (suite === "public-business") {
      const { runPublicBusiness } = await import("./business-public.mjs");
      report.suites[suite] = await runPublicBusiness({ seed, output: path.join(output, suite) });
    } else if (suite === "public-coding") {
      const { runPublicCodingHistory, runPublicCodingCases } = await import("./public-coding.mjs");
      const options = { seed, outputDir: path.join(output, suite), provider: publicProvider };
      await mkdir(options.outputDir, { recursive: true });
      const history = await runPublicCodingHistory(options);
      const rows = await runPublicCodingCases(options);
      const success = rows.filter((row) => row.passed).length;
      report.suites[suite] = {
        history,
        total: rows.length,
        success,
        model: publicProvider.model,
        passed: history.passed && rows.length > 0 && success === rows.length,
      };
    } else if (suite === "capabilities") {
      const { runHistoricalCapabilities } = await import("./historical-capabilities.mjs");
      report.suites[suite] = await runHistoricalCapabilities(output);
    } else {
      let run;
      if (suite === "retrieval")
        ({ runRetrievalCases: run } = await import("./retrieval-generalization.mjs"));
      if (suite === "business")
        ({ runBusinessCases: run } = await import("./business-generalization.mjs"));
      if (suite === "durable")
        ({ runDurableCases: run } = await import("./durable-generalization.mjs"));
      if (suite === "workflow")
        ({ runWorkflowCases: run } = await import("./workflow-generalization.mjs"));
      const rows = await run({ seed });
      await json(`${suite}-cases.json`, rows);
      if (!rows.length) throw new Error("生成器返回空套件");
      for (const row of rows) {
        if (
          ids.has(row.id) ||
          !row.id ||
          !row.type ||
          !row.category ||
          typeof row.passed !== "boolean" ||
          !Number.isFinite(row.durationMs) ||
          row.durationMs < 0 ||
          !("expected" in row) ||
          !("actual" in row)
        )
          throw new Error(`案例回执无效或 ID 重复：${row.id}`);
        ids.add(row.id);
        report.types[row.type] ??= {
          total: 0,
          passed: 0,
          failedIds: [],
          categories: {},
        };
        const type = report.types[row.type];
        type.total++;
        type.categories[row.category] = (type.categories[row.category] ?? 0) + 1;
        if (row.passed) type.passed++;
        else type.failedIds.push(row.id);
      }
      report.suites[suite] = {
        total: rows.length,
        success: rows.filter((row) => row.passed).length,
        passed: rows.every((row) => row.passed),
      };
    }
  } catch (error) {
    report.suites[suite] = { passed: false, error: error.message };
  }
  const summary = report.suites[suite];
  summary.durationMs = Math.round(performance.now() - start);
  report.passed &&= summary.passed === true;
  console.log(suite, summary.passed ? "PASS" : "FAIL", `${summary.durationMs} ms`);
  await json("report.json", report);
}
if (Object.values(report.types).some((type) => type.total < 30)) {
  report.passed = false;
  report.coverageError = "有类型的变体少于 30 条";
  await json("report.json", report);
}
if (!report.passed) process.exitCode = 1;

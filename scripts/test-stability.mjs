import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const npmCli = process.env.npm_execpath;
const totalRuns = 3;
const latencyProject = "isolated-input-receipt-acceptance";
const faultMatrixProject = "isolated-trusted-tool-fault-matrix";
const remainingProjects = "!isolated-*";
const evidencePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".scratch",
  `stability-node-${process.platform}.json`,
);

if (process.env.GITHUB_RUN_ID) rmSync(evidencePath, { force: true });

function runTests(project, env) {
  const args = [
    "test",
    "--",
    `--project=${project}`,
    ...(project === remainingProjects ? ["--maxWorkers=1"] : []),
  ];
  return npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { stdio: "inherit", env })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        stdio: "inherit",
        env,
        shell: process.platform === "win32",
      });
}

let completedRuns = 0;
for (let run = 1; run <= totalRuns; run += 1) {
  console.log(`稳定性测试 ${run}/${totalRuns}`);
  const env = { ...process.env, COREMIND_STABILITY_RUN: String(run) };
  const latencyResult = runTests(latencyProject, env);
  const faultMatrixResult =
    latencyResult.status === 0 ? runTests(faultMatrixProject, env) : latencyResult;
  const result =
    faultMatrixResult.status === 0 ? runTests(remainingProjects, env) : faultMatrixResult;
  if (result.status !== 0) {
    console.error(`稳定性测试第 ${run} 次失败`);
    process.exitCode = result.status ?? 1;
    break;
  }
  completedRuns += 1;
}

if (
  completedRuns === totalRuns &&
  ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "GITHUB_SHA"].every(
    (name) => process.env[name],
  )
) {
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(
    evidencePath,
    `${JSON.stringify({
      schemaVersion: 1,
      outcome: "passed",
      completedRuns,
      platform: process.platform,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      job: process.env.GITHUB_JOB,
      commit: process.env.GITHUB_SHA,
    })}\n`,
    "utf8",
  );
}

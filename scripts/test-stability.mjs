import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
const totalRuns = 3;
const latencyProject = "isolated-input-receipt-acceptance";
const faultMatrixProject = "isolated-trusted-tool-fault-matrix";
const remainingProjects = "!isolated-*";

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
}

import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
const totalRuns = 3;
const latencyProject = "coremind-runtime-input-receipt-acceptance";
const faultMatrixProject = "trusted-tool-fault-matrix";

function runTests(projects, env) {
  const args = ["test", "--", ...projects.map((project) => `--project=${project}`)];
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
  const latencyResult = runTests([latencyProject], env);
  const faultMatrixResult =
    latencyResult.status === 0 ? runTests([faultMatrixProject], env) : latencyResult;
  const result =
    faultMatrixResult.status === 0
      ? runTests([`!${latencyProject}`, `!${faultMatrixProject}`], env)
      : faultMatrixResult;
  if (result.status !== 0) {
    console.error(`稳定性测试第 ${run} 次失败`);
    process.exitCode = result.status ?? 1;
    break;
  }
}

import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
const totalRuns = 3;

for (let run = 1; run <= totalRuns; run += 1) {
  console.log(`稳定性测试 ${run}/${totalRuns}`);
  const env = { ...process.env, COREMIND_STABILITY_RUN: String(run) };
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, "test"], { stdio: "inherit", env })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], {
        stdio: "inherit",
        env,
        shell: process.platform === "win32",
      });
  if (result.status !== 0) {
    console.error(`稳定性测试第 ${run} 次失败`);
    process.exitCode = result.status ?? 1;
    break;
  }
}

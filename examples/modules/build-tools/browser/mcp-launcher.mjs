import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const [, , pidFile, cli, browser, ...args] = process.argv;
await writeFile(pidFile, `${process.pid}\n`, "utf8");
const spawn = childProcess.spawn;
// 只记录本次 MCP 服务直接启动的测试浏览器。
childProcess.spawn = (command, ...options) => {
  const child = spawn(command, ...options);
  if (command === browser && child.pid) appendFileSync(pidFile, `${child.pid}\n`, "utf8");
  return child;
};
syncBuiltinESMExports();
process.argv = [process.execPath, cli, ...args];
await import(pathToFileURL(cli).href);

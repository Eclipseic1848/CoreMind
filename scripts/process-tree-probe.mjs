import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
process.stdout.write(`CHILD_PID:${child.pid}\n`);
setInterval(() => {}, 1000);

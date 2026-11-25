import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function startOntology(
  modelDir,
  { enableActions = false, python, cwd, env, readToken, actionToken },
) {
  const args = [
    "-B",
    "-X",
    "utf8",
    path.join(import.meta.dirname, "ontology_server.py"),
    "--model-dir",
    modelDir,
    "--port",
    "0",
  ];
  if (enableActions) args.push("--enable-actions");
  return startLocalPython(args, {
    python,
    cwd,
    env: {
      ...env,
      COREMIND_ONTOLOGY_AUTHORIZATION: readToken,
      COREMIND_ONTOLOGY_ACTION_AUTHORIZATION: actionToken,
    },
  });
}

export async function startLocalPython(args, { python, cwd, env }) {
  const child = spawn(python, args, {
    cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const isRunning = () =>
    child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const close = async () => {
    if (isRunning()) {
      if (process.platform === "win32") {
        // Windows 的虚拟环境启动器与实际服务属于同一子进程树。
        await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 5000,
        }).catch((error) => {
          if (isRunning()) throw error;
        });
      } else {
        child.kill();
      }
    }
    await closed;
  };
  let stderr = "";
  let timer;
  try {
    const origin = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => reject(new Error(`本体服务退出 ${code}：${stderr}`)));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const url = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr)?.[1];
        if (url) resolve(url);
      });
      timer = setTimeout(() => reject(new Error(`本体服务启动超时：${stderr}`)), 15_000);
      timer.unref();
    });
    return { origin, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

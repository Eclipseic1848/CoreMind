import { spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pty from "node-pty";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "coremind-cli", "dist", "cli.js");
const mockServer = path.join(root, "scripts", "tty-mock-provider.mjs");
const platform = process.platform === "win32" ? "windows" : "linux";
const port = Number(process.env.COREMIND_TTY_MOCK_PORT ?? 18879);
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const commit = process.env.GITHUB_SHA || gitValue(["rev-parse", "HEAD"]);
const workspace = await mkdtemp(path.join(tmpdir(), `coremind-tty-${platform}-`));
const config = path.join(workspace, "coremind.yaml");
const target = path.join(workspace, "article.md");
const evidenceDirectory = path.join(root, ".scratch", "rc-evidence");
const evidencePath = path.join(evidenceDirectory, `rc-tty-${platform}.json`);
const server = spawnChild(process.execPath, [mockServer, String(port)], {
  cwd: root,
  stdio: "ignore",
});
let completed = false;

try {
  await writeConfig(config, port);
  await waitForServer(port);

  const basic = await openTerminal(config, workspace, "tty-session");
  await basic.command("/help", "/artifacts");
  await basic.command("/status", "尚未完成任何运行。");
  await basic.command("TTY验收", "mock回复：TTY验收");
  await basic.waitFor("succeeded · operation completed");
  await basic.exit();
  if (!existsSync(path.join(workspace, "sessions", "tty-session.jsonl"))) {
    throw new Error("成功运行后没有保存会话");
  }

  const resumed = await openTerminal(config, workspace, "tty-session");
  await resumed.waitFor("已恢复会话 tty-session");
  await resumed.exit();

  const denied = await openTerminal(config, workspace, "tty-denied");
  await denied.write("写入验收文件");
  await denied.waitFor("权限审批：write");
  await denied.key("n");
  await denied.waitFor("运行暂停");
  await denied.waitFor("paused · operation paused");
  if (existsSync(target)) throw new Error("拒绝审批后仍产生文件副作用");
  await denied.command("/checkpoints", "当前没有 checkpoint。");
  await denied.exit();

  const allowed = await openTerminal(config, workspace, "tty-allowed");
  await allowed.write("写入验收文件");
  await allowed.waitFor("权限审批：write");
  await allowed.key("y");
  await allowed.waitFor("工具完成");
  await allowed.waitFor("succeeded · operation completed");
  if (!existsSync(target)) throw new Error("批准审批后没有产生目标文件");
  await allowed.command("/checkpoints", "write · 可恢复");
  const checkpointId = allowed
    .output()
    .match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) · write · 可恢复/u)?.[1];
  if (!checkpointId) throw new Error("无法从真实 TTY 输出读取 checkpoint id");
  await allowed.command(`/diff ${checkpointId}`, "changed=true");
  await allowed.command(`/restore ${checkpointId}`, `已恢复 checkpoint ${checkpointId}`);
  if (existsSync(target)) throw new Error("恢复 checkpoint 后目标文件仍存在");
  await allowed.exit();

  const aborted = await openTerminal(config, workspace, "tty-abort");
  await aborted.write("生成慢回复");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await aborted.write("/abort");
  await aborted.waitFor("运行中止");
  await aborted.waitFor("aborted · operation failed");
  await aborted.exit();

  const evidence = {
    schemaVersion: 1,
    platform,
    version,
    commit,
    testedAt: new Date().toISOString(),
    terminal: platform === "windows" ? "Windows ConPTY" : "Linux pseudoterminal",
    passed: true,
    checks: {
      launch: true,
      help: true,
      "approval-deny": true,
      "approval-allow": true,
      abort: true,
      "session-resume": true,
      "checkpoint-diff-restore": true,
      streaming: true,
      status: true,
      exit: true,
    },
    evidenceLevel: "automated-real-tty",
    notes:
      "真实伪终端进程验证键盘命令、流式输出、拒绝零副作用、批准写入、checkpoint diff/restore、会话恢复、中止与正常退出。",
  };
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`真实 TTY 自动验收通过：${platform} · ${path.relative(root, evidencePath)}`);
  completed = true;
} finally {
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  await removeWorkspace(workspace);
}
if (completed) process.exit(0);

async function openTerminal(configPath, cwd, sessionId) {
  const terminal = pty.spawn(process.execPath, [cli, "chat", configPath, "--session", sessionId], {
    cwd,
    cols: 160,
    rows: 50,
    env: {
      ...process.env,
      CI: "false",
      COREMIND_TTY_TEST_KEY: "synthetic-key",
      NO_COLOR: "1",
    },
    ...(process.platform === "win32" ? { useConpty: true } : {}),
  });
  let output = "";
  let rawOutput = "";
  let exitResult;
  terminal.onData((chunk) => {
    rawOutput += chunk;
    output += stripAnsi(chunk);
  });
  const exitPromise = new Promise((resolve) =>
    terminal.onExit((result) => {
      exitResult = result;
      resolve(result);
    }),
  );
  // Linux 子进程可能在监听器注册前完成首屏渲染；resize 会要求 TUI 在同一真实伪终端内重绘。
  terminal.resize(159, 50);
  terminal.resize(160, 50);
  await waitFor(
    () => output.includes("你 >"),
    "输入框",
    () => output,
    () =>
      exitResult
        ? `CLI 已提前退出：code=${exitResult.exitCode} signal=${exitResult.signal}; raw=${stripAnsi(rawOutput).slice(-2_000)}`
        : undefined,
  );
  return {
    output: () => output,
    waitFor: (marker) =>
      waitFor(
        () => output.includes(marker),
        marker,
        () => output,
      ),
    key: async (value) => terminal.write(value),
    write: (value) => typeCommand(terminal, value),
    command: async (value, marker) => {
      const offset = output.length;
      await typeCommand(terminal, value);
      await waitFor(
        () => output.slice(offset).includes(marker),
        marker,
        () => output,
      );
    },
    exit: async () => {
      await typeCommand(terminal, "/exit");
      let exitTimeout;
      try {
        const result = await Promise.race([
          exitPromise,
          new Promise((_, reject) => {
            exitTimeout = setTimeout(
              () => reject(new Error("真实 TTY 未在退出命令后结束")),
              15_000,
            );
          }),
        ]);
        if (result.exitCode !== 0) throw new Error(`CLI 退出码应为 0，实际为 ${result.exitCode}`);
      } finally {
        clearTimeout(exitTimeout);
        if (!exitResult) process.kill(terminal.pid);
      }
    },
  };
}

async function writeConfig(file, serverPort) {
  await writeFile(
    file,
    [
      "schemaVersion: 2",
      `name: ${platform}-tty-acceptance`,
      "provider:",
      "  id: mock",
      `  baseUrl: http://127.0.0.1:${serverPort}/v1`,
      "  model: mock-model",
      "  apiKeyEnv: COREMIND_TTY_TEST_KEY",
      "tools:",
      "  - id: write",
      "agents:",
      "  main:",
      "    systemPrompt: 按用户要求执行测试任务。",
      "    tools:",
      "      - id: write",
      "runtime:",
      "  maxTurns: 3",
      "permissions:",
      "  mode: ask",
      "  workspaceOnly: true",
      "  network: ask",
      "session:",
      "  enabled: true",
      "  dir: ./sessions",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function typeCommand(terminal, command) {
  for (const character of command) {
    terminal.write(character);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  terminal.write("\r");
}

async function waitFor(predicate, label, output, failure) {
  for (let attempt = 0; attempt < 2_400; attempt += 1) {
    if (predicate()) return;
    const failureMessage = failure?.();
    if (failureMessage) throw new Error(failureMessage);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待真实 TTY ${label} 超时：${output().slice(-2_000)}`);
}

async function waitForServer(serverPort) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/health`);
      if (response.status === 204) return;
    } catch {
      // 服务启动前按 100ms 有界重试。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("本地 Mock Provider 未在 5 秒内启动");
}

function gitValue(args) {
  const completed = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (completed.status !== 0) throw new Error("无法读取候选 Git 提交");
  return completed.stdout.trim();
}

function stripAnsi(value) {
  return value.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: TTY 验收必须移除标准 ANSI 控制序列。
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu,
    "",
  );
}

async function removeWorkspace(directory) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

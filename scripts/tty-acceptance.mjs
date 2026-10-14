import { spawn as spawnChild, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const terminals = new Set();

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

  for (const mode of ["tui", "readline"]) {
    await rm(target, { force: true });
    const terminal = await openTerminal(config, workspace, `tty-control-${mode}`, mode);
    const steering = `追加标记-${mode} y n`;
    const followUp = `后续标记-${mode} y n`;
    const draft = `保留草稿-${mode}`;
    await terminal.write(`控制验收-${mode}：写入验收文件`);
    await terminal.waitFor(mode === "tui" ? "权限审批：write" : "工具 write 请求");
    await terminal.command(`/steer ${steering}`, "· applied");
    await terminal.command(`/follow-up ${followUp}`, "· applied");
    if (existsSync(target)) throw new Error(`${mode} 控制命令意外批准了原写入审批`);
    if ((await controlStatus(mode)).requests.length !== 1)
      throw new Error(`${mode} 审批期间控制触发了额外模型请求`);
    await terminal.key(mode === "tui" ? "y" : "y\r");
    await waitFor(
      async () => (await controlStatus(mode)).waiting,
      `${mode} 工具批准后请求门`,
      terminal.output,
    );
    await terminal.write(draft);
    await terminal.waitFor(draft);
    const offset = terminal.output().length;
    const released = await fetch(`http://127.0.0.1:${port}/control/release/${mode}`, {
      method: "POST",
    });
    if (released.status !== 204) throw new Error(`${mode} 控制请求门未正确释放`);
    await terminal.waitFor(`后续输入已消费：${mode}`, offset);
    await terminal.waitFor(
      mode === "tui" ? "succeeded · operation completed" : `草稿待确认：${draft}`,
      offset,
    );
    const state = await controlStatus(mode);
    if (
      state.requests.length !== 3 ||
      state.requests.some((messages) =>
        messages.some((message) => message.role === "user" && textOf(message.content) === draft),
      )
    )
      throw new Error(`${mode} 普通草稿被自动执行或控制请求次数不符`);
    if (!existsSync(target)) throw new Error(`${mode} 明确批准后写入没有执行`);
    await verifyControlFacts(mode, steering, followUp);
    const draftOffset = terminal.output().length;
    await terminal.key("\r");
    await terminal.waitFor(`草稿已显式发送：${mode}`, offset);
    await terminal.waitFor(mode === "tui" ? "输入就绪" : "你 >", draftOffset);
    const confirmed = await controlStatus(mode);
    if (
      confirmed.requests.length !== 4 ||
      textOf(
        [...confirmed.requests[3]].reverse().find((message) => message.role === "user")?.content,
      ) !== draft
    )
      throw new Error(`${mode} 显式确认时原草稿未被保留`);
    await terminal.exit();
  }

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
      "control-tui": true,
      "control-readline": true,
      "control-approval-isolation": true,
      "draft-explicit-send": true,
      "control-input-facts": true,
    },
    evidenceLevel: "automated-real-tty",
    notes:
      "真实伪终端进程验证键盘命令、流式输出、拒绝零副作用、批准写入、checkpoint diff/restore、会话恢复、中止、两入口控制与审批隔离、输入消费事实、草稿显式确认和正常退出。",
  };
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`真实 TTY 自动验收通过：${platform} · ${path.relative(root, evidencePath)}`);
  completed = true;
} finally {
  for (const terminal of terminals) terminal.kill();
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  await removeWorkspace(workspace);
}
if (completed) process.exit(0);

async function openTerminal(configPath, cwd, sessionId, mode = "tui") {
  const terminal = pty.spawn(
    process.execPath,
    [cli, "chat", configPath, "--session", sessionId, ...(mode === "readline" ? ["--no-tui"] : [])],
    {
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
    },
  );
  terminals.add(terminal);
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
      terminals.delete(terminal);
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
    waitFor: (marker, offset = 0) =>
      waitFor(
        () => output.slice(offset).includes(marker),
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
    if (await predicate()) return;
    const failureMessage = failure?.();
    if (failureMessage) throw new Error(failureMessage);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待真实 TTY ${label} 超时：${output().slice(-2_000)}`);
}

async function controlStatus(mode) {
  const response = await fetch(`http://127.0.0.1:${port}/control/status/${mode}`);
  if (!response.ok) throw new Error(`无法读取 ${mode} 控制夹具状态`);
  return response.json();
}

async function verifyControlFacts(mode, steering, followUp) {
  const runDirectory = path.join(workspace, ".coremind", "runs");
  const documents = await Promise.all(
    (await readdir(runDirectory))
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) =>
        (await readFile(path.join(runDirectory, name), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ),
  );
  const runs = documents.filter((records) =>
    records.some(
      (record) =>
        record.kind === "start" &&
        record.payload.initialPrompt === `控制验收-${mode}：写入验收文件`,
    ),
  );
  if (
    runs.length !== 1 ||
    !runs[0].some(
      (record) => record.kind === "finish" && record.payload.outcome.status === "succeeded",
    )
  )
    throw new Error(`${mode} 控制没有在同一个成功 Run 内完成`);
  const records = runs[0];
  const accepted = records.filter(
    (record) => record.kind === "control" && record.payload.state === "accepted",
  );
  const applied = records.filter(
    (record) => record.kind === "control" && record.payload.state === "applied",
  );
  if (
    accepted.length !== 2 ||
    applied.length !== 2 ||
    new Set(accepted.map((record) => record.payload.controlId)).size !== 2 ||
    applied.some(
      (record) =>
        !accepted.some((candidate) => candidate.payload.controlId === record.payload.controlId),
    )
  )
    throw new Error(`${mode} 持久控制身份或状态不完整`);
  const events = records
    .filter((record) => record.kind === "event")
    .map((record) => record.payload.event);
  const fingerprints = [steering, followUp].map((text) =>
    createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16),
  );
  const inputs = events.filter(
    (event) => event.type === "input_receipt" && fingerprints.includes(event.contentFingerprint),
  );
  if (inputs.length !== 2 || new Set(inputs.map((event) => event.inputId)).size !== 2)
    throw new Error(`${mode} 控制输入没有两个独立身份`);
  for (const input of inputs) {
    const receipts = events.filter((event) => event.inputId === input.inputId);
    if (
      receipts.map((event) => event.type).join(",") !==
        "input_receipt,input_claimed,input_completed" ||
      !events.some((event) => event.type === "turn_end" && event.turnId === receipts[1].turnId)
    )
      throw new Error(`${mode} 控制消费与实际 Turn 不一致`);
  }
}

function textOf(content) {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : "";
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

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatSession, type CoreMindConfig, CoreMindRuntime, FileRunStore } from "coremind-ai";
import { ProjectionEngine } from "coremind-ai/internal";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "./approval.js";
import { ChatTUI } from "./tui.js";

/**
 * 四入口请求等价验收（Issue #39 / 规格 04 门 A-2）：
 * CLI / TUI / TS SDK / Python SDK 对同一 fixture 连 mock provider，
 * 生成等价的规范化请求、同一 outcome 机器码、结构等价的 RunSnapshot。
 */

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const workerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../coremind-worker/dist/stdio.js",
);
const pythonSrcPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../python/src",
);

/** wire 消息的规范化签名（去掉时间戳/用量等易变字段） */
interface WireSignature {
  role: string;
  text: string;
  toolCalls?: Array<{ name: string; args: string }>;
  toolName?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item === "object" && "text" in item ? String(item.text) : ""))
      .join("");
  }
  return "";
}

function wireSignatures(messages: unknown[]): WireSignature[] {
  const toolCallIds = new Map<string, string>();
  return messages.map((raw) => {
    const message = raw as {
      role?: string;
      content?: unknown;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      tool_call_id?: string;
    };
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls.map((call) => {
        toolCallIds.set(call.id, call.function.name);
        return { name: call.function.name, args: stableJson(JSON.parse(call.function.arguments)) };
      });
      return { role: "assistant", text: textOf(message.content), toolCalls: calls };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        text: textOf(message.content),
        toolName: message.tool_call_id ? toolCallIds.get(message.tool_call_id) : undefined,
      };
    }
    return { role: message.role ?? "", text: textOf(message.content) };
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/** 结果等价指纹：outcome 机器码 + RunSnapshot 关键结构字段（门 A-2） */
interface ResultFingerprint {
  outcomeStatus: string;
  snapshotSchemaVersion: number;
  snapshotResumable: boolean;
  capabilityEffect: string;
  capabilitySource: string;
  recoveryDisposition: string;
}

interface SnapshotFingerprintInput {
  schemaVersion: number;
  resumable: boolean;
  trace: Array<{
    event: {
      type: string;
      capability?: { effect?: string; source?: string };
      recoveryDisposition?: string;
    };
  }>;
}

function fingerprintOf(
  outcomeStatus: string,
  snapshot: SnapshotFingerprintInput,
): ResultFingerprint {
  const capability = snapshot.trace.find(
    (entry) => entry.event.type === "capability_resolved",
  )?.event;
  return {
    outcomeStatus,
    snapshotSchemaVersion: snapshot.schemaVersion,
    snapshotResumable: snapshot.resumable,
    capabilityEffect: capability?.capability?.effect ?? "missing",
    capabilitySource: capability?.capability?.source ?? "missing",
    recoveryDisposition: capability?.recoveryDisposition ?? "missing",
  };
}

async function fingerprintFromFacts(
  directory: string,
  runId: string,
  outcomeStatus: string,
): Promise<ResultFingerprint> {
  const store = new FileRunStore(path.join(directory, ".coremind", "runs"));
  const projection = ProjectionEngine.project(await store.read(runId));
  expect(projection.snapshot).toBeDefined();
  return fingerprintOf(outcomeStatus, projection.snapshot!);
}

/** 假 Provider：记录每次请求的规范化签名，脚本化返回纯文本响应 */
async function createEquivalenceServer(
  onRequest: (signatures: WireSignature[]) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages: unknown[] };
      const signatures = wireSignatures(parsed.messages);
      onRequest(signatures);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunks = signatures.some((message) => message.role === "tool")
        ? [
            {
              id: "eq-final",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "读取完成" },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "eq-final",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ]
        : [
            {
              id: "eq-tool",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-read-equivalence",
                        type: "function",
                        function: { name: "read", arguments: '{"path":"notes.txt"}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "eq-tool",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
          ];
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

/** fixture 配置（指向指定 mock provider 端口） */
function fixtureConfig(port: number): CoreMindConfig {
  return {
    schemaVersion: 2,
    name: "等价性验收",
    provider: {
      id: "probe",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "probe-model",
      apiKey: "test-key",
    },
    agents: { main: { systemPrompt: "助手" } },
    tools: [{ id: "read" }],
    permissions: { mode: "assisted", workspaceOnly: true, network: "deny" },
  };
}

function prepareFixtureFile(directory: string, missingFile: boolean): void {
  if (!missingFile) writeFileSync(path.join(directory, "notes.txt"), "四入口能力一致", "utf8");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 入口 1：TS SDK——直接驱动 CoreMindRuntime */
async function captureTsSdk(missingFile = false): Promise<{
  signatures: WireSignature[];
  fingerprint: ResultFingerprint;
}> {
  const captured: WireSignature[] = [];
  const { server, port } = await createEquivalenceServer((signatures) =>
    captured.push(...signatures),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "coremind-eq-ts-"));
  prepareFixtureFile(dir, missingFile);
  try {
    const runtime = await CoreMindRuntime.create({
      config: fixtureConfig(port),
      configDir: dir,
      cwd: dir,
      initialPrompt: "你好",
    });
    const result = await runtime.run();
    expect(result.outcome.status).toBe("succeeded");
    return {
      signatures: captured,
      fingerprint: await fingerprintFromFacts(dir, result.runId, result.outcome.status),
    };
  } finally {
    await closeServer(server);
  }
}

/** spawn 子进程并等待退出，返回退出码与合并输出（非 async executor） */
function spawnAndWait(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: "pipe", env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 入口 2：CLI——异步 spawn dist/cli.js run --json-events（同步 spawn 会阻塞 mock server 事件循环） */
async function captureCli(missingFile = false): Promise<{
  signatures: WireSignature[];
  fingerprint: ResultFingerprint;
}> {
  const captured: WireSignature[] = [];
  const { server, port } = await createEquivalenceServer((signatures) =>
    captured.push(...signatures),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "coremind-eq-cli-"));
  const configPath = path.join(dir, "coremind.yaml");
  prepareFixtureFile(dir, missingFile);
  // 配置文件支持 JSON 格式（YAML/JSON 双格式）
  writeFileSync(configPath, JSON.stringify(fixtureConfig(port)), "utf8");
  try {
    const { code, stdout, stderr } = await spawnAndWait(
      "node",
      [cliPath, "run", configPath, "--prompt", "你好", "--json-events"],
      { cwd: dir },
    );
    expect(code, stderr).toBe(0);
    expect(stderr).not.toContain("Error");
    // 解析 run_result 事件（含 outcome 与 snapshot）
    const runResult = stdout
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as {
            type?: string;
            runId?: string;
            outcome?: { status?: string };
            snapshot?: SnapshotFingerprintInput;
          };
        } catch {
          return null;
        }
      })
      .find((item) => item && item.type === "run_result");
    expect(runResult).toBeTruthy();
    expect(runResult?.outcome?.status).toBe("succeeded");
    return {
      signatures: captured,
      fingerprint: await fingerprintFromFacts(
        dir,
        runResult?.runId ?? "",
        runResult?.outcome?.status ?? "",
      ),
    };
  } finally {
    await closeServer(server);
  }
}

/** 逐字符写入 TUI 输入（与 tui.test.tsx 一致） */
async function typeCommand(write: (value: string) => void, command: string): Promise<void> {
  for (const character of command) {
    write(character);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  write("\r");
}

/** 轮询直到捕获到请求或超时 */
async function waitForCapture(
  captured: WireSignature[],
  expectedCount = 1,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (captured.length < expectedCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (captured.length < expectedCount) throw new Error("未捕获到完整工具请求链");
}

async function waitForTuiFingerprint(
  read: () => ResultFingerprint | undefined,
  timeoutMs = 5_000,
): Promise<ResultFingerprint> {
  const deadline = Date.now() + timeoutMs;
  while (read() === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const fingerprint = read();
  if (!fingerprint) throw new Error("TUI 渲染入口未返回运行结果");
  return fingerprint;
}

/** 入口 3a：TUI——ink 渲染 ChatTUI + 真实 ChatSession 驱动一轮对话（请求等价） */
async function captureTui(missingFile = false): Promise<{
  signatures: WireSignature[];
  fingerprint: ResultFingerprint;
}> {
  const captured: WireSignature[] = [];
  const { server, port } = await createEquivalenceServer((signatures) =>
    captured.push(...signatures),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "coremind-eq-tui-"));
  prepareFixtureFile(dir, missingFile);
  try {
    const runtime = await CoreMindRuntime.create({
      config: fixtureConfig(port),
      configDir: dir,
      cwd: dir,
    });
    const session = new ChatSession(runtime, "main");
    const chat = session.chat.bind(session);
    let fingerprint: ResultFingerprint | undefined;
    vi.spyOn(session, "chat").mockImplementation(async (message) => {
      const turn = await chat(message);
      fingerprint = await fingerprintFromFacts(dir, turn.run.runId, turn.run.outcome.status);
      return turn;
    });
    const app = render(
      <ChatTUI
        title="等价性验收"
        session={session}
        approvals={new ApprovalQueue(true)}
        onExit={vi.fn()}
      />,
    );
    await typeCommand(app.stdin.write, "你好");
    await waitForCapture(captured, 6);
    const resultFingerprint = await waitForTuiFingerprint(() => fingerprint);
    app.unmount();
    return { signatures: captured, fingerprint: resultFingerprint };
  } finally {
    await closeServer(server);
  }
}

/** 入口 4：Python SDK——spawn 临时脚本驱动 CoreMindClient（经 worker 连 mock provider） */
async function capturePython(missingFile = false): Promise<{
  signatures: WireSignature[];
  fingerprint: ResultFingerprint;
}> {
  const captured: WireSignature[] = [];
  const { server, port } = await createEquivalenceServer((signatures) =>
    captured.push(...signatures),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "coremind-eq-py-"));
  prepareFixtureFile(dir, missingFile);
  const scriptPath = path.join(dir, "capture.py");
  const script = [
    "import sys, json",
    `sys.path.insert(0, ${JSON.stringify(pythonSrcPath)})`,
    "from coremind.client import CoreMindClient",
    "client = CoreMindClient({",
    '  "schemaVersion": 2,',
    '  "name": "等价性验收",',
    `  "provider": {"id": "probe", "baseUrl": "http://127.0.0.1:${port}/v1", "model": "probe-model", "apiKey": "test-key"},`,
    '  "agents": {"main": {"systemPrompt": "助手"}},',
    '  "tools": [{"id": "read"}],',
    '  "permissions": {"mode": "assisted", "workspaceOnly": True, "network": "deny"},',
    "}, config_dir=" +
      JSON.stringify(dir) +
      ", cwd=" +
      JSON.stringify(dir) +
      ", request_timeout=60)",
    'result = client.run("你好")',
    'print("RUN_ID:" + result["runId"])',
    'print("OUTCOME:" + json.dumps(result["outcome"]))',
    'snap = result["snapshot"]',
    'print("SNAPSHOT:" + json.dumps({"schemaVersion": snap["schemaVersion"], "resumable": snap["resumable"], "trace": snap["trace"]}))',
    "client.close()",
  ].join("\n");
  writeFileSync(scriptPath, script, "utf8");
  try {
    const { code, stdout, stderr } = await spawnAndWait("python", [scriptPath], {
      cwd: dir,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", COREMIND_WORKER_PATH: workerPath },
    });
    expect(code, stderr).toBe(0);
    expect(stderr).not.toContain("Traceback");
    const outcomeLine = stdout.split("\n").find((line) => line.startsWith("OUTCOME:"));
    const runIdLine = stdout.split("\n").find((line) => line.startsWith("RUN_ID:"));
    const snapshotLine = stdout.split("\n").find((line) => line.startsWith("SNAPSHOT:"));
    expect(outcomeLine).toBeTruthy();
    expect(runIdLine).toBeTruthy();
    expect(snapshotLine).toBeTruthy();
    const outcome = JSON.parse(outcomeLine!.slice("OUTCOME:".length)) as { status: string };
    const snapshot = JSON.parse(snapshotLine!.slice("SNAPSHOT:".length)) as {
      schemaVersion: number;
      resumable: boolean;
      trace: SnapshotFingerprintInput["trace"];
    };
    expect(outcome.status).toBe("succeeded");
    expect(snapshot.schemaVersion).toBe(1);
    return {
      signatures: captured,
      fingerprint: await fingerprintFromFacts(
        dir,
        runIdLine!.slice("RUN_ID:".length).trim(),
        outcome.status,
      ),
    };
  } finally {
    await closeServer(server);
  }
}

describe("四入口请求等价（门 A-2）", () => {
  it("TS SDK / CLI / TUI / Python 驱动同 fixture 生成等价规范化请求与结果", async () => {
    const [tsCaptured, cliCaptured, tuiCaptured, pyCaptured] = await Promise.all([
      captureTsSdk(),
      captureCli(),
      captureTui(),
      capturePython(),
    ]);
    // 工具 fixture：首请求两条，第二次请求包含原请求、toolUse 与 toolResult。
    expect(tsCaptured.signatures.map((item) => item.role)).toEqual([
      "system",
      "user",
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    // 规范化请求等价：CLI / TUI / Python 与 TS SDK 逐条一致
    expect(cliCaptured.signatures).toEqual(tsCaptured.signatures);
    expect(tuiCaptured.signatures).toEqual(tsCaptured.signatures);
    expect(pyCaptured.signatures).toEqual(tsCaptured.signatures);
    // outcome 同一机器码 + RunSnapshot 结构等价（门 A-2）
    expect(cliCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(pyCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tuiCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tsCaptured.fingerprint).toMatchObject({
      capabilityEffect: "none",
      capabilitySource: "builtin",
      recoveryDisposition: "replay_safe",
    });
  });

  it("Tool Error fault fixture 在四入口生成相同结果与 RecoveryDisposition", async () => {
    const [tsCaptured, cliCaptured, tuiCaptured, pyCaptured] = await Promise.all([
      captureTsSdk(true),
      captureCli(true),
      captureTui(true),
      capturePython(true),
    ]);

    expect(cliCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tuiCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(pyCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    for (const captured of [tsCaptured, cliCaptured, tuiCaptured, pyCaptured]) {
      expect(captured.signatures.some((item) => item.role === "tool")).toBe(true);
    }
  });
});

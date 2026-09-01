import "../../../test/setup-env.js";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChatSession,
  type CoreMindConfig,
  CoreMindRuntime,
  FileRunStore,
  type LocalObservabilityProjection,
  parseAndValidate,
} from "coremind-ai";
import { ProjectionEngine } from "coremind-ai/internal";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "./approval.js";
import { ChatTUI } from "./tui.js";

/**
 * 四入口请求等价验收（Issue #39 / #107，规格 04 门 A-2 / P0-12）：
 * CLI / TUI / TS SDK / Python SDK 对同一 fixture 连 mock provider，
 * 生成等价的规范化请求、同一 outcome 机器码、结构等价的 RunSnapshot 与 Child Run tree。
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
const delegationConfigPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test/mock-delegation-config.json",
);

/** wire 消息的规范化签名（去掉时间戳/用量等易变字段） */
interface WireSignature {
  role: string;
  text: string;
  toolCalls?: Array<{ name: string; args: string }>;
  toolName?: string;
}

interface EntryCapture {
  signatures: WireSignature[];
  fingerprint: ResultFingerprint;
  port: number;
}

interface ProviderFault {
  code: string;
  status?: number;
  expectedStatus: "failed" | "paused";
  expectedExitCode: 1 | 2;
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
        text: String(normalizeFact(textOf(message.content), "toolResult")),
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
  observabilitySchemaVersion: number;
  localObservabilityEnabled: boolean;
  telemetryMode: string;
  telemetrySource: string;
  telemetryContentLevel: string;
  exporterLoaded: boolean;
  contextBudgets: number;
  contextCompactions: number;
  callsStarted: number;
  callsCompleted: number;
  deliverySemantics: string;
  authorizedScopeCount: number;
  normalizedFacts: unknown[];
  outcome: unknown;
  recovery: unknown;
  context: unknown;
  childRuns: unknown;
  providerRequests: unknown[];
}

type LiveResultFingerprint = Omit<
  ResultFingerprint,
  "normalizedFacts" | "outcome" | "recovery" | "context" | "providerRequests"
>;

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
  observability: LocalObservabilityProjection,
): LiveResultFingerprint {
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
    observabilitySchemaVersion: observability.schemaVersion,
    localObservabilityEnabled: observability.localEnabled,
    telemetryMode: observability.telemetry.mode,
    telemetrySource: observability.telemetry.source,
    telemetryContentLevel: observability.telemetry.contentLevel,
    exporterLoaded: observability.telemetry.exporterLoaded,
    contextBudgets: observability.context.budgets,
    contextCompactions: observability.context.compactions,
    callsStarted: observability.calls.started,
    callsCompleted: observability.calls.completed,
    deliverySemantics: observability.telemetry.deliverySemantics,
    authorizedScopeCount: observability.telemetry.authorizedScopes.length,
  };
}

async function fingerprintFromFacts(
  directory: string,
  runId: string,
  outcomeStatus: string,
): Promise<ResultFingerprint> {
  const store = new FileRunStore(path.join(directory, ".coremind", "runs"));
  const records = await store.read(runId);
  const projection = ProjectionEngine.project(records);
  expect(projection.snapshot).toBeDefined();
  return {
    ...fingerprintOf(outcomeStatus, projection.snapshot!, projection.observability),
    normalizedFacts: projection.records.map((record) => normalizeFact(record)),
    outcome: normalizeFact(projection.outcome),
    recovery: normalizeFact(projection.recovery),
    context: normalizeFact(projection.context),
    childRuns: normalizeFact(projection.childRuns),
    providerRequests: projection.trace.flatMap((entry) =>
      entry.event.type === "provider_request"
        ? [
            normalizeFact({
              requestId: entry.event.requestId,
              providerId: entry.event.providerId,
              modelId: entry.event.modelId,
              messageFingerprint: entry.event.messageFingerprint,
              toolSchemaFingerprint: entry.event.toolSchemaFingerprint,
              capabilityFingerprint: entry.event.capabilityFingerprint,
              contextWorkingSetFingerprint: entry.event.contextWorkingSetFingerprint,
            }),
          ]
        : [],
    ),
  };
}

function normalizeFact(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeFact(item));
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && key === "durationMs") return "<duration>";
    if (typeof value !== "string") return value;
    if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) return "<timestamp>";
    if (
      /^(?:inputFingerprint|workingSetFingerprint|contextWorkingSetFingerprint|messageFingerprint)$/u.test(
        key,
      ) &&
      /^(?:sha256:)?[0-9a-f]{64}$/iu.test(value)
    ) {
      return `<${key}>`;
    }
    if (key === "correlationId" || key === "idempotencyKey") return `<${key}>`;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
      return `<${key || "uuid"}>`;
    }
    return value
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu,
        "<uuid>",
      )
      .replace(/[A-Z]:\\[^'"\r\n]*/giu, "<path>")
      .replace(/\/(?:tmp|var\/tmp)\/[^'"\r\n]*/gu, "<path>");
  }
  const omitted = new Set([
    "timestamp",
    "configuredAt",
    "sessionId",
    "sessionSeqStart",
    "turnSeqStart",
  ]);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([field, item]) => !omitted.has(field) && item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([field, item]) => [field, normalizeFact(item, field)]),
  );
}

/** 假 Provider：记录每次请求的规范化签名，脚本化返回纯文本响应 */
async function createEquivalenceServer(
  onRequest: (signatures: WireSignature[]) => void,
  options: {
    port?: number;
    toolError?: boolean;
    providerFault?: ProviderFault;
    childRun?: "success" | "failure";
  } = {},
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as {
        messages: unknown[];
        tools?: Array<{ function?: { name?: string } }>;
      };
      const signatures = wireSignatures(parsed.messages);
      onRequest(signatures);
      const hasToolResult = signatures.some((message) => message.role === "tool");
      const hasDelegationTool =
        parsed.tools?.some((tool) => tool.function?.name === "delegate") ?? false;
      if (options.providerFault) {
        response.writeHead(options.providerFault.status ?? 400, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: { code: options.providerFault.code, message: "固定 Provider 错误" },
          }),
        );
        return;
      }
      if (options.childRun === "failure" && !hasToolResult && !hasDelegationTool) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { code: "vendor_auth_failure", message: "固定 Child Provider 未分类错误" },
          }),
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunks = options.childRun
        ? hasToolResult
          ? textResponse("parent-final", "父任务完成")
          : hasDelegationTool
            ? toolCallResponse(
                "parent-tool",
                "call-delegate",
                "delegate",
                '{"target":"researcher","task":"研究已批准事实","references":[],"limits":{"tokens":800}}',
              )
            : textResponse("child-final", "子任务完成")
        : hasToolResult
          ? textResponse("eq-final", "读取完成")
          : toolCallResponse(
              "eq-tool",
              "call-read-equivalence",
              options.toolError ? "fault_probe" : "read",
              options.toolError ? "{}" : '{"path":"notes.txt"}',
            );
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

function textResponse(id: string, content: string): Array<Record<string, unknown>> {
  return [
    {
      id,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content },
          finish_reason: null,
        },
      ],
    },
    { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

function toolCallResponse(
  id: string,
  callId: string,
  name: string,
  args: string,
): Array<Record<string, unknown>> {
  return [
    {
      id,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: args },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

/** fixture 配置（指向指定 mock provider 端口） */
function fixtureConfig(
  port: number,
  toolError = false,
  childRun?: "success" | "failure",
): CoreMindConfig {
  if (childRun) {
    const fixture = JSON.parse(readFileSync(delegationConfigPath, "utf8")) as CoreMindConfig;
    return parseAndValidate({
      ...fixture,
      provider: { ...fixture.provider!, baseUrl: `http://127.0.0.1:${port}/v1` },
    }).config;
  }
  return parseAndValidate({
    schemaVersion: 2,
    name: "等价性验收",
    provider: {
      id: "probe",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "probe-model",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    agents: { main: { systemPrompt: "助手" } },
    defaultAgent: "main",
    tools: toolError
      ? [
          {
            path: "fault-tool.mjs",
            name: "fault_probe",
            effect: { operations: ["read"], reversible: true },
          },
        ]
      : [{ id: "read" }],
    permissions: { mode: "assisted", workspaceOnly: true, network: "deny" },
  }).config;
}

function prepareFixtureFiles(directory: string, toolError: boolean): void {
  if (!toolError) {
    writeFileSync(path.join(directory, "notes.txt"), "四入口能力一致", "utf8");
    return;
  }
  writeFileSync(
    path.join(directory, "fault-tool.mjs"),
    `export default {
  name: "fault_probe",
  description: "产生固定错误的等价性测试工具",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => { const error = new Error("deterministic-tool-error"); error.code = "tool_execution_failed"; throw error; }
};\n`,
    "utf8",
  );
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 入口 1：TS SDK——直接驱动 CoreMindRuntime */
async function captureTsSdk(
  toolError = false,
  fixedPort?: number,
  fixedDirectory?: string,
  providerFault?: ProviderFault,
  childRun?: "success" | "failure",
): Promise<EntryCapture> {
  const captured: WireSignature[] = [];
  const { server, port } = await createEquivalenceServer(
    (signatures) => captured.push(...signatures),
    {
      ...(fixedPort === undefined ? {} : { port: fixedPort }),
      toolError,
      providerFault,
      childRun,
    },
  );
  const dir = fixedDirectory ?? mkdtempSync(path.join(tmpdir(), "coremind-eq-ts-"));
  prepareFixtureFiles(dir, toolError);
  try {
    const runtime = await CoreMindRuntime.create({
      config: fixtureConfig(port, toolError, childRun),
      configDir: dir,
      cwd: dir,
      initialPrompt: "你好",
    });
    const result = await runtime.run();
    expect(result.outcome.status).toBe(
      childRun === "failure" ? "paused" : (providerFault?.expectedStatus ?? "succeeded"),
    );
    const liveFingerprint = fingerprintOf(
      result.outcome.status,
      result.snapshot,
      result.observability,
    );
    const fingerprint = await fingerprintFromFacts(dir, result.runId, result.outcome.status);
    expect(fingerprint).toMatchObject(liveFingerprint);
    return {
      signatures: captured,
      fingerprint,
      port,
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
async function captureCli(
  toolError = false,
  fixedPort?: number,
  fixedDirectory?: string,
  providerFault?: ProviderFault,
  childRun?: "success" | "failure",
): Promise<EntryCapture> {
  const captured: WireSignature[] = [];
  const { server, port } = await createEquivalenceServer(
    (signatures) => captured.push(...signatures),
    {
      ...(fixedPort === undefined ? {} : { port: fixedPort }),
      toolError,
      providerFault,
      childRun,
    },
  );
  const dir = fixedDirectory ?? mkdtempSync(path.join(tmpdir(), "coremind-eq-cli-"));
  const configPath = path.join(dir, "coremind.yaml");
  prepareFixtureFiles(dir, toolError);
  // 配置文件支持 JSON 格式（YAML/JSON 双格式）
  writeFileSync(configPath, JSON.stringify(fixtureConfig(port, toolError, childRun)), "utf8");
  try {
    const { code, stdout, stderr } = await spawnAndWait(
      "node",
      [cliPath, "run", configPath, "--prompt", "你好", "--json-events"],
      { cwd: dir },
    );
    expect(code, stderr).toBe(childRun === "failure" ? 2 : (providerFault?.expectedExitCode ?? 0));
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
            observability?: LocalObservabilityProjection;
          };
        } catch {
          return null;
        }
      })
      .find((item) => item && item.type === "run_result");
    expect(runResult).toBeTruthy();
    const expectedStatus =
      childRun === "failure" ? "paused" : (providerFault?.expectedStatus ?? "succeeded");
    expect(runResult?.outcome?.status).toBe(expectedStatus);
    expect(runResult?.snapshot).toBeDefined();
    expect(runResult?.observability).toBeDefined();
    const liveFingerprint = fingerprintOf(
      runResult?.outcome?.status ?? "",
      runResult!.snapshot!,
      runResult!.observability!,
    );
    const fingerprint = await fingerprintFromFacts(dir, runResult?.runId ?? "", expectedStatus);
    expect(fingerprint).toMatchObject(liveFingerprint);
    return {
      signatures: captured,
      fingerprint,
      port,
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
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (captured.length < expectedCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (captured.length < expectedCount) throw new Error("未捕获到完整工具请求链");
}

async function waitForTuiFingerprint(
  read: () => ResultFingerprint | undefined,
  timeoutMs = 15_000,
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
async function captureTui(
  toolError = false,
  fixedPort?: number,
  fixedDirectory?: string,
  providerFault?: ProviderFault,
  childRun?: "success" | "failure",
): Promise<EntryCapture> {
  const captured: WireSignature[] = [];
  const { server, port } = await createEquivalenceServer(
    (signatures) => captured.push(...signatures),
    {
      ...(fixedPort === undefined ? {} : { port: fixedPort }),
      toolError,
      providerFault,
      childRun,
    },
  );
  const dir = fixedDirectory ?? mkdtempSync(path.join(tmpdir(), "coremind-eq-tui-"));
  prepareFixtureFiles(dir, toolError);
  try {
    const runtime = await CoreMindRuntime.create({
      config: fixtureConfig(port, toolError, childRun),
      configDir: dir,
      cwd: dir,
    });
    const session = new ChatSession(runtime, "main");
    const chat = session.chat.bind(session);
    let fingerprint: ResultFingerprint | undefined;
    vi.spyOn(session, "chat").mockImplementation(async (message) => {
      const turn = await chat(message);
      expect(turn.run.outcome.status).toBe(
        childRun === "failure" ? "paused" : (providerFault?.expectedStatus ?? "succeeded"),
      );
      const liveFingerprint = fingerprintOf(
        turn.run.outcome.status,
        turn.run.snapshot,
        turn.run.observability,
      );
      fingerprint = await fingerprintFromFacts(dir, turn.run.runId, turn.run.outcome.status);
      expect(fingerprint).toMatchObject(liveFingerprint);
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
    await waitForCapture(captured, childRun ? 8 : providerFault ? 2 : 6);
    const resultFingerprint = await waitForTuiFingerprint(() => fingerprint);
    app.unmount();
    return { signatures: captured, fingerprint: resultFingerprint, port };
  } finally {
    await closeServer(server);
  }
}

/** 入口 4：Python SDK——spawn 临时脚本驱动 CoreMindClient（经 worker 连 mock provider） */
async function capturePython(
  toolError = false,
  fixedPort?: number,
  fixedDirectory?: string,
  providerFault?: ProviderFault,
  childRun?: "success" | "failure",
): Promise<EntryCapture> {
  const captured: WireSignature[] = [];
  const { server, port } = await createEquivalenceServer(
    (signatures) => captured.push(...signatures),
    {
      ...(fixedPort === undefined ? {} : { port: fixedPort }),
      toolError,
      providerFault,
      childRun,
    },
  );
  const dir = fixedDirectory ?? mkdtempSync(path.join(tmpdir(), "coremind-eq-py-"));
  prepareFixtureFiles(dir, toolError);
  const scriptPath = path.join(dir, "capture.py");
  const configJson = JSON.stringify(fixtureConfig(port, toolError, childRun));
  const script = [
    "import sys, json",
    `sys.path.insert(0, ${JSON.stringify(pythonSrcPath)})`,
    "from coremind.client import CoreMindClient",
    `config = json.loads(${JSON.stringify(configJson)})`,
    "client = CoreMindClient(config, config_dir=" +
      JSON.stringify(dir) +
      ", cwd=" +
      JSON.stringify(dir) +
      ", request_timeout=30)",
    'result = client.run("你好")',
    'print("RUN_ID:" + result["runId"])',
    'print("OUTCOME:" + json.dumps(result["outcome"]))',
    'snap = result["snapshot"]',
    'print("SNAPSHOT:" + json.dumps({"schemaVersion": snap["schemaVersion"], "resumable": snap["resumable"], "trace": snap["trace"]}))',
    'print("OBSERVABILITY:" + json.dumps(result["observability"]))',
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
    const observabilityLine = stdout.split("\n").find((line) => line.startsWith("OBSERVABILITY:"));
    expect(outcomeLine).toBeTruthy();
    expect(runIdLine).toBeTruthy();
    expect(snapshotLine).toBeTruthy();
    expect(observabilityLine).toBeTruthy();
    const outcome = JSON.parse(outcomeLine!.slice("OUTCOME:".length)) as { status: string };
    const snapshot = JSON.parse(snapshotLine!.slice("SNAPSHOT:".length)) as {
      schemaVersion: number;
      resumable: boolean;
      trace: SnapshotFingerprintInput["trace"];
    };
    const observability = JSON.parse(
      observabilityLine!.slice("OBSERVABILITY:".length),
    ) as LocalObservabilityProjection;
    expect(outcome.status).toBe(
      childRun === "failure" ? "paused" : (providerFault?.expectedStatus ?? "succeeded"),
    );
    expect(snapshot.schemaVersion).toBe(1);
    const liveFingerprint = fingerprintOf(outcome.status, snapshot, observability);
    const fingerprint = await fingerprintFromFacts(
      dir,
      runIdLine!.slice("RUN_ID:".length).trim(),
      outcome.status,
    );
    expect(fingerprint).toMatchObject(liveFingerprint);
    return {
      signatures: captured,
      fingerprint,
      port,
    };
  } finally {
    await closeServer(server);
  }
}

describe("四入口请求等价（门 A-2）", () => {
  it("TS SDK / CLI / TUI / Python 驱动同 fixture 生成等价规范化请求与结果", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-eq-success-"));
    const tsCaptured = await captureTsSdk(false, undefined, directory);
    const cliCaptured = await captureCli(false, tsCaptured.port, directory);
    const tuiCaptured = await captureTui(false, tsCaptured.port, directory);
    const pyCaptured = await capturePython(false, tsCaptured.port, directory);
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

  it("TS SDK / CLI / TUI / Python 对同一正式 Child Run fixture 保持完整合同等价", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-eq-child-run-"));
    const tsCaptured = await captureTsSdk(false, undefined, directory, undefined, "success");
    const cliCaptured = await captureCli(false, tsCaptured.port, directory, undefined, "success");
    const tuiCaptured = await captureTui(false, tsCaptured.port, directory, undefined, "success");
    const pyCaptured = await capturePython(false, tsCaptured.port, directory, undefined, "success");

    expect(tsCaptured.signatures.map((message) => message.role)).toEqual([
      "system",
      "user",
      "system",
      "user",
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(cliCaptured.signatures).toEqual(tsCaptured.signatures);
    expect(tuiCaptured.signatures).toEqual(tsCaptured.signatures);
    expect(pyCaptured.signatures).toEqual(tsCaptured.signatures);
    expect(cliCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tuiCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(pyCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tsCaptured.fingerprint.childRuns).toMatchObject({
      activeDescendants: 0,
      unhandledDescendants: 0,
      quiescent: true,
      nodes: [
        {
          parentRunId: "<parentRunId>",
          childRunId: "<childRunId>",
          delegationId: "delegation:<uuid>:call-delegate",
          inputFingerprint: "<inputFingerprint>",
          agentName: "researcher",
          status: "joined",
          budget: {
            tokens: 800,
            toolCalls: 2,
            costUsd: 1,
            wallTimeMs: 20_000,
            steps: 2,
            descendants: 0,
          },
          outcome: { status: "succeeded", finishReason: "completed" },
          result: {
            recovery: {
              recoveryDisposition: "replay_safe",
              effectState: "none",
              quiescent: true,
              executionOwnership: "released",
            },
          },
          disposition: { state: "not_required" },
        },
      ],
    });
  }, 90_000);

  it("四入口对同一 Child Run 失败保持错误、处置门与非静止语义等价", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-eq-child-failure-"));
    const tsCaptured = await captureTsSdk(false, undefined, directory, undefined, "failure");
    const cliCaptured = await captureCli(false, tsCaptured.port, directory, undefined, "failure");
    const tuiCaptured = await captureTui(false, tsCaptured.port, directory, undefined, "failure");
    const pyCaptured = await capturePython(false, tsCaptured.port, directory, undefined, "failure");

    expect(cliCaptured.signatures).toEqual(tsCaptured.signatures);
    expect(tuiCaptured.signatures).toEqual(tsCaptured.signatures);
    expect(pyCaptured.signatures).toEqual(tsCaptured.signatures);
    expect(cliCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tuiCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(pyCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tsCaptured.fingerprint.outcome).toMatchObject({
      status: "paused",
      error: { code: "delegation_disposition_required" },
    });
    expect(tsCaptured.fingerprint.childRuns).toMatchObject({
      activeDescendants: 0,
      unhandledDescendants: 1,
      quiescent: false,
      nodes: [
        {
          agentName: "researcher",
          status: "joined",
          outcome: { status: "paused", error: { code: "unclassified_error" } },
          disposition: { state: "required", requiredActor: "parent_agent" },
        },
      ],
    });
  }, 90_000);

  it("Tool Error fault fixture 在四入口生成相同结果与 RecoveryDisposition", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-eq-fault-"));
    const tsCaptured = await captureTsSdk(true, undefined, directory);
    const cliCaptured = await captureCli(true, tsCaptured.port, directory);
    const tuiCaptured = await captureTui(true, tsCaptured.port, directory);
    const pyCaptured = await capturePython(true, tsCaptured.port, directory);

    expect(cliCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tuiCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(pyCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    for (const captured of [tsCaptured, cliCaptured, tuiCaptured, pyCaptured]) {
      expect(captured.signatures.some((item) => item.role === "tool")).toBe(true);
    }
  });

  it("已知 Provider 瞬态错误在四入口给出相同登记码与处置结果", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-eq-rate-limit-"));
    const fault: ProviderFault = {
      code: "vendor_rate_limit",
      status: 429,
      expectedStatus: "failed",
      expectedExitCode: 1,
    };
    const tsCaptured = await captureTsSdk(false, undefined, directory, fault);
    const cliCaptured = await captureCli(false, tsCaptured.port, directory, fault);
    const tuiCaptured = await captureTui(false, tsCaptured.port, directory, fault);
    const pyCaptured = await capturePython(false, tsCaptured.port, directory, fault);

    expect(cliCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tuiCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(pyCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tsCaptured.fingerprint.outcome).toMatchObject({
      status: "failed",
      error: { code: "provider_transient" },
    });
    expect(tsCaptured.fingerprint.recovery).toMatchObject({
      resumable: false,
      requiresHuman: false,
    });
  }, 45_000);

  it("未知 Provider 错误在四入口失败关闭并要求人工处置", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-eq-unclassified-error-"));
    const fault: ProviderFault = {
      code: "vendor_private_error?token=provider-secret",
      expectedStatus: "paused",
      expectedExitCode: 2,
    };
    const tsCaptured = await captureTsSdk(false, undefined, directory, fault);
    const cliCaptured = await captureCli(false, tsCaptured.port, directory, fault);
    const tuiCaptured = await captureTui(false, tsCaptured.port, directory, fault);
    const pyCaptured = await capturePython(false, tsCaptured.port, directory, fault);

    expect(cliCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tuiCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(pyCaptured.fingerprint).toEqual(tsCaptured.fingerprint);
    expect(tsCaptured.fingerprint.outcome).toMatchObject({
      status: "paused",
      error: {
        code: "unclassified_error",
        audit: { originalCode: expect.stringContaining("vendor_private_error?token=hidden") },
      },
    });
    expect(tsCaptured.fingerprint.recovery).toMatchObject({
      resumable: false,
      requiresHuman: true,
    });
    expect(JSON.stringify(tsCaptured.fingerprint)).not.toContain("provider-secret");
  });
});

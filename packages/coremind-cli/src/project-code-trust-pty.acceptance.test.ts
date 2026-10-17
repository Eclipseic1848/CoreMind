import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { type CoreMindEvent, ProjectionEngine, type RunStateRecord } from "coremind-ai";
import pty from "node-pty";
import { expect, it } from "vitest";

const cli = process.env.COREMIND_TEST_CLI_PATH
  ? path.resolve(process.env.COREMIND_TEST_CLI_PATH)
  : fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const observer = fileURLToPath(
  new URL("../../../test/fixtures/terminal-input-observer.mjs", import.meta.url),
);
const trustPrompt = "是否信任？[y/N]";
type Command = "run" | "chat" | "eval";

for (const command of ["run", "chat", "eval"] as const) {
  for (const ending of ["interrupt", "eof"] as const) {
    it(`真实 PTY ${command} 加载确认 ${ending} 保持取消与拒绝身份`, async () => {
      await withTrustTerminal(command, false, async (terminal) => {
        terminal.send(ending === "interrupt" ? "\x03" : "\x04");
        await terminal.waitExit(ending === "interrupt" ? 130 : 1);
        const { stdout, stderr, input } = await terminal.logs();
        const bytes = ending === "interrupt" ? "03" : "04";
        expect(input[0]).toMatchObject({ type: "terminal", isTTY: true });
        expect(
          input.some(
            (entry) =>
              entry.type === "data" &&
              Buffer.from(String(entry.hex), "hex").includes(Buffer.from(bytes, "hex")),
          ),
        ).toBe(true);
        expect(existsSync(terminal.file("imported"))).toBe(false);
        expect(existsSync(terminal.file("approved.md"))).toBe(false);
        expect(terminal.requests).toHaveLength(0);
        expect(await terminal.runs()).toEqual([]);
        if (ending === "interrupt") {
          expect(stderr).toContain(command === "eval" ? "评测已取消" : "运行已取消");
          expect(stdout.trim()).toBe("");
        } else {
          expect(stderr).not.toContain("已取消");
          if (command === "eval") {
            const result = JSON.parse(stdout);
            expect(result.totalRuns).toBe(4);
            expect(result.attempts).toHaveLength(4);
            for (const attempt of result.attempts) {
              expect(attempt.outcome.error.code).toBe("execution_security_violation");
            }
          } else {
            expect(stderr).toContain("加载项目脚本需要宿主明确批准");
          }
        }
      });
    }, 40_000);
  }
}

it("真实 PTY run JSONL 批准加载后仍独立拒绝工具，stdout不混信任提示", async () => {
  await withTrustTerminal("run", true, async (terminal) => {
    const offset = terminal.outputOffset();
    terminal.send("y\r");
    await terminal.waitText("工具 write 请求", offset);
    const pending = await terminal.waitApproval();
    const events = eventsOf(pending);
    const required = events.filter((event) => event.type === "approval_required");
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({ tool: "write", callId: "project-trust-write" });
    expect(events.filter((event) => event.type === "approval_resolved")).toEqual([]);
    expect(await readFile(terminal.file("imported"), "utf8")).toBe("loaded\n");
    expect(existsSync(terminal.file("approved.md"))).toBe(false);
    expect(terminal.requests).toHaveLength(1);
    terminal.send("n\r");
    await terminal.waitExit(2);
    const { stdout, stderr } = await terminal.logs();
    const output = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(output.length).toBeGreaterThan(0);
    expect(output.filter((event) => event.type === "run_result")).toEqual([
      expect.objectContaining({ outcome: expect.objectContaining({ status: "paused" }) }),
    ]);
    expect(stdout).not.toContain(trustPrompt);
    expect(stdout).not.toContain("工具 write 请求");
    expect(stderr).toContain(trustPrompt);
    expect(stderr).toContain("工具 write 请求");
    const runs = await terminal.runs();
    expect(runs).toHaveLength(1);
    const projection = ProjectionEngine.project(runs[0]!);
    expect(projection.outcome?.status).toBe("paused");
    const finalEvents = eventsOf(runs[0]!);
    expect(finalEvents.filter((event) => event.type === "approval_resolved")).toEqual([
      expect.objectContaining({ approvalId: required[0]!.approvalId, decision: "deny" }),
    ]);
    const receipts = finalEvents.filter(
      (event) => event.type === "effect_receipt" && event.tool === "write",
    );
    expect(receipts.length).toBeGreaterThan(0);
    expect(
      receipts.every((event) => event.type === "effect_receipt" && event.status === "not_started"),
    ).toBe(true);
    expect(existsSync(terminal.file("approved.md"))).toBe(false);
    expect(terminal.requests).toHaveLength(1);
  });
}, 40_000);

interface TrustTerminal {
  requests: unknown[];
  file(relative: string): string;
  send(text: string): void;
  outputOffset(): number;
  waitText(text: string, offset?: number): Promise<void>;
  waitExit(code: number): Promise<void>;
  logs(): Promise<{ stdout: string; stderr: string; input: Array<Record<string, unknown>> }>;
  runs(): Promise<RunStateRecord[][]>;
  waitApproval(): Promise<RunStateRecord[]>;
}

async function withTrustTerminal(
  command: Command,
  json: boolean,
  action: (terminal: TrustTerminal) => Promise<void>,
) {
  expect(existsSync(cli), "必须先构建真实CLI；本测试不生成产物").toBe(true);
  const cliSha256 = createHash("sha256")
    .update(await readFile(cli))
    .digest("hex");
  const workspace = await mkdtemp(path.join(tmpdir(), "coremind-project-trust-pty-"));
  const file = (relative: string) => {
    const resolved = path.resolve(workspace, relative);
    const within = path.relative(path.resolve(workspace), resolved);
    assert(
      within && !path.isAbsolute(within) && within !== ".." && !within.startsWith(`..${path.sep}`),
    );
    return resolved;
  };
  const deadline = performance.now() + 30_000;
  const requests: unknown[] = [];
  const failures: unknown[] = [];
  const sockets = new Set<Socket>();
  const sends: Array<{ text: string; hex: string }> = [];
  let raw = "";
  let terminal: pty.IPty | undefined;
  let exit: { exitCode: number; signal?: number } | undefined;
  let passed = false;
  let cleanupKilled = false;
  let failure: unknown;
  let args: string[] = [];
  let outputSubscription: { dispose(): void } | undefined;
  let exitSubscription: { dispose(): void } | undefined;
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      try {
        requests.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "text/event-stream" });
        const first = requests.length === 1;
        const delta = first
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "project-trust-write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ path: "approved.md", content: "不得执行" }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "完成" };
        for (const [content, finish] of [
          [delta, null],
          [{}, first ? "tool_calls" : "stop"],
        ]) {
          response.write(
            `data: ${JSON.stringify({ id: "project-trust", choices: [{ index: 0, delta: content, finish_reason: finish }] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      } catch (error) {
        failures.push(error);
        response.end();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    while (!(await predicate())) {
      if (failures.length) throw failures[0];
      if (Buffer.byteLength(raw, "utf8") > 8 * 1024 * 1024) throw new Error("PTY输出超过8MiB");
      if (performance.now() >= deadline)
        throw new Error(`${label}；${stripVTControlCharacters(raw).slice(-1_000)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const readRuns = async () => {
    const directory = file(".coremind/runs");
    if (!existsSync(directory)) return [];
    return Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith(".jsonl"))
        .map(async (name) => {
          const text = await readFile(file(`.coremind/runs/${name}`), "utf8");
          const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
          return complete
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as RunStateRecord);
        }),
    );
  };
  const logs = async () => ({
    stdout: await readFile(file("stdout.txt"), "utf8"),
    stderr: await readFile(file("stderr.txt"), "utf8"),
    input: (await readFile(file("stdin.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    for (const name of ["stdout.txt", "stderr.txt", "stdin.jsonl"])
      await writeFile(file(name), "", "utf8");
    // 分别记录写入调用后原样转发；不改变TTY、背压、输出目的地或stdin所有权。
    await writeFile(
      file("record-output.mjs"),
      `import { appendFileSync } from "node:fs";
for (const name of ["stdout", "stderr"]) {
  const stream = process[name];
  const original = stream.write;
  stream.write = function (chunk, ...args) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof args[0] === "string" ? args[0] : "utf8") : chunk;
    appendFileSync(process.env[name === "stdout" ? "COREMIND_PTY_STDOUT_LOG" : "COREMIND_PTY_STDERR_LOG"], bytes);
    return Reflect.apply(original, this, [chunk, ...args]);
  };
}
// readline 可直接接收 data，不经过 Ink 的显式 read；只观察并原样转发事件。
const originalEmit = process.stdin.emit;
process.stdin.emit = function (event, ...args) {
  if (event === "data") {
    const bytes = typeof args[0] === "string" ? Buffer.from(args[0], "utf8") : args[0];
    appendFileSync(process.env.COREMIND_PTY_INPUT_LOG, JSON.stringify({ type: "data", hex: bytes.toString("hex") }) + "\\n", "utf8");
  }
  return Reflect.apply(originalEmit, this, [event, ...args]);
};
`,
      "utf8",
    );
    await writeFile(
      file("trust-probe.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./imported", import.meta.url), "loaded\\n", "utf8");
export default { name: "trust_probe", description: "加载验收", parameters: { type: "object", properties: {} },
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) };
`,
      "utf8",
    );
    await writeFile(
      file("coremind.json"),
      JSON.stringify({
        schemaVersion: 2,
        name: "加载信任PTY",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          model: "probe-model",
          apiKeyEnv: "COREMIND_TEST_API_KEY",
        },
        tools: [
          { path: "trust-probe.mjs", effect: { operations: ["read"], reversible: true } },
          { id: "write" },
        ],
        agents: { main: {} },
        quality: { profile: "development" },
        permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
        runtime: { maxRetries: 0, maxTurns: 3, runTimeoutMs: 15_000 },
      }),
      "utf8",
    );
    await writeFile(
      file("suite.json"),
      JSON.stringify({
        schemaVersion: 1,
        scenarios: ["first", "next"].map((id) => ({
          id,
          input: id,
          repetitions: 2,
          expected: { outcome: "succeeded" },
        })),
      }),
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "false",
      NO_COLOR: "1",
      TERM: "xterm-256color",
      COREMIND_TEST_API_KEY: "offline-test-only",
      COREMIND_PTY_INPUT_LOG: file("stdin.jsonl"),
      COREMIND_PTY_STDOUT_LOG: file("stdout.txt"),
      COREMIND_PTY_STDERR_LOG: file("stderr.txt"),
    };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    delete environment.COREMIND_WORKER_PATH;
    args = [
      "--import",
      pathToFileURL(observer).href,
      "--import",
      pathToFileURL(file("record-output.mjs")).href,
      cli,
      command,
      file("coremind.json"),
      ...(command === "run"
        ? ["--prompt", "加载后写入验收", ...(json ? ["--json-events"] : [])]
        : command === "eval"
          ? ["--suite", file("suite.json"), "--json"]
          : []),
    ];
    terminal = pty.spawn(process.execPath, args, {
      cwd: workspace,
      cols: 120,
      rows: 40,
      encoding: "utf8",
      env: environment,
      ...(process.platform === "win32" ? { useConpty: true, conptyInheritCursor: false } : {}),
    });
    outputSubscription = terminal.onData((chunk) => {
      raw += chunk;
    });
    exitSubscription = terminal.onExit((result) => {
      exit = result;
    });
    const send = (text: string) => {
      assert(terminal && !exit);
      sends.push({ text, hex: Buffer.from(text, "utf8").toString("hex") });
      terminal.write(text);
    };
    const waitText = (text: string, offset = 0) =>
      waitFor(
        () =>
          stripVTControlCharacters(raw.slice(offset))
            .replace(/\s/gu, "")
            .includes(text.replace(/\s/gu, "")),
        `未显示${text}`,
      );
    await waitText(trustPrompt);
    expect(existsSync(file("imported"))).toBe(false);
    expect(existsSync(file("approved.md"))).toBe(false);
    expect(requests).toHaveLength(0);
    await action({
      file,
      requests,
      send,
      waitText,
      logs,
      runs: readRuns,
      outputOffset: () => raw.length,
      waitApproval: async () => {
        let selected: RunStateRecord[] | undefined;
        await waitFor(async () => {
          selected = (await readRuns()).find((records) =>
            eventsOf(records).some(
              (event) =>
                event.type === "approval_required" &&
                event.tool === "write" &&
                event.callId === "project-trust-write",
            ),
          );
          return selected !== undefined;
        }, "独立工具审批Fact尚未落盘");
        return selected!;
      },
      waitExit: async (code) => {
        await waitFor(() => exit !== undefined, "CLI未自然退出");
        expect(exit).toMatchObject({ exitCode: code });
        expect(exit!.signal ?? 0).toBe(0);
      },
    });
    assert(exit, "验收动作必须等待CLI自然退出");
    await waitFor(() => sockets.size === 0, "自然退出后socket未收敛");
    expect(failures).toEqual([]);
    passed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const socketsBeforeFixtureCleanup = sockets.size;
    if (terminal && !exit) {
      cleanupKilled = true;
      terminal.kill();
      const cleanupDeadline = performance.now() + 3_000;
      while (!exit && performance.now() < cleanupDeadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (exit) {
      outputSubscription?.dispose();
      exitSubscription?.dispose();
    }
    if (process.platform === "win32" && terminal && exit) {
      // 只释放已结束CLI的父端排空线程，不以kill伪装EOF或成功。
      (
        terminal as unknown as { _agent?: { _conoutSocketWorker?: { dispose(): void } } }
      )._agent?._conoutSocketWorker?.dispose();
    }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await writeFile(file("pty-raw.txt"), raw, "utf8");
    await writeFile(file("sends.json"), JSON.stringify(sends), "utf8");
    await writeFile(file("model-requests.json"), JSON.stringify(requests), "utf8");
    await writeFile(
      file("proof.json"),
      JSON.stringify({
        passed: passed && !cleanupKilled,
        workspace,
        command,
        json,
        cli,
        cliSha256,
        argv: args,
        platform: process.platform,
        terminal: process.platform === "win32" ? "Windows ConPTY" : "POSIX PTY",
        naturalExit: Boolean(exit && !cleanupKilled),
        exit,
        cleanupKilled,
        socketsBeforeFixtureCleanup,
        modelRequests: requests.length,
        error: failure ? String(failure) : undefined,
      }),
      "utf8",
    );
    console.log(`真实加载信任PTY证据：${workspace}`);
  }
}

function eventsOf(records: RunStateRecord[]): CoreMindEvent[] {
  return records
    .filter((record) => record.kind === "event")
    .map((record) => {
      assert(
        record.payload && typeof record.payload === "object" && !Array.isArray(record.payload),
      );
      return (record.payload as Record<string, unknown>).event as CoreMindEvent;
    });
}

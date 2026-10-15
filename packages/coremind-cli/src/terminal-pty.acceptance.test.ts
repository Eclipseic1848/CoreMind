import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { type CoreMindEvent, ProjectionEngine, type RunStateRecord } from "coremind-ai";
import pty from "node-pty";
import { expect, it } from "vitest";
import { startMcpAuthServer } from "../../../test/fixtures/mcp-auth-server.mjs";
import { startMcpHttpServer } from "../../../test/fixtures/mcp-http-server.mjs";

// 同一旅程也核对独立安装的候选 CLI，不把仓库构建误作制品回装。
const cli = process.env.COREMIND_TEST_CLI_PATH
  ? path.resolve(process.env.COREMIND_TEST_CLI_PATH)
  : fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const observer = fileURLToPath(
  new URL("../../../test/fixtures/terminal-input-observer.mjs", import.meta.url),
);
const blockedCanary = "terminal-artifact-secret-canary";
const safeValue = "真实安全正文".repeat(2_000);
const blockedValue = `${safeValue}\nTOKEN=${blockedCanary}`;
const storedCall = "terminal-same-tool-stored";
const blockedCall = "terminal-same-tool-blocked";

interface ModelRequest {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>;
}
type Reply = (
  request: ModelRequest,
  ordinal: number,
) =>
  | { text: string }
  | {
      text?: string;
      calls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    };
interface RunEvidence {
  file: string;
  raw: string;
  records: RunStateRecord[];
}

it("真实 PTY 在三种尺寸保留中文草稿，完整退格字符簇并一次提交合并末字 CR", async () => {
  await withTerminal(
    "edit",
    (request, ordinal) => {
      expect(ordinal).toBe(1);
      expect(lastUser(request)).toBe("中文草稿末字");
      return { text: "中文输入已完整接收" };
    },
    {},
    async (terminal) => {
      await terminal.resize(40, 16);
      terminal.send("中文草稿👩🏽‍💻");
      await terminal.waitText("中文草稿👩🏽‍💻");
      terminal.send("\x7f");
      await terminal.resize(80, 24);
      terminal.send("末字\r");
      await terminal.waitText("中文输入已完整接收");
      const run = await terminal.waitRun("中文草稿末字", "succeeded");
      const events = eventsOf(run);
      expect(events.filter((event) => event.type === "input_receipt")).toHaveLength(1);
      expect(events.find((event) => event.type === "input_receipt")).toMatchObject({
        contentFingerprint: fingerprint("中文草稿末字"),
      });
      const chunks = await terminal.inputChunks();
      expect(chunks[0]).toMatchObject({ type: "terminal", isTTY: true });
      expect(
        chunks.some(
          (chunk) =>
            chunk.type === "read" &&
            Buffer.from(String(chunk.hex), "hex").toString("utf8").includes("末字\r"),
        ),
        "一次发送与子进程真正读到合并块必须分别证明；不能补发 Enter",
      ).toBe(true);
      await terminal.resize(120, 40);
      expect(terminal.requests).toHaveLength(1);
    },
  );
}, 40_000);

it("真实 PTY 审批粘贴 y 只留稿，合并 steer 生效后仍等待原审批，独立 y 才写入", async () => {
  const steering = "追加中文 y n";
  await withTerminal(
    "approval",
    (request, ordinal) => {
      if (ordinal === 1) {
        expect(lastUser(request)).toBe("执行终端审批验收");
        return {
          calls: [
            {
              id: "terminal-write",
              name: "write",
              args: { path: "approved.md", content: "明确批准后写入" },
            },
          ],
        };
      }
      expect(ordinal).toBe(2);
      expect(lastUser(request)).toBe(steering);
      expect(request.messages.some((message) => message.role === "tool")).toBe(true);
      return { text: "审批与追加输入已完成" };
    },
    {
      tools: [{ id: "write" }],
      agents: { main: { tools: [{ id: "write" }] } },
      permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
    },
    async (terminal) => {
      terminal.send("执行终端审批验收\r");
      await terminal.waitText("权限审批：write");
      const pending = await terminal.waitFacts("执行终端审批验收", (events) =>
        events.some((event) => event.type === "approval_required"),
      );
      const required = eventsOf(pending).find((event) => event.type === "approval_required");
      assert(required?.type === "approval_required");
      for (const [cols, rows] of [
        [40, 16],
        [80, 24],
        [120, 40],
      ] as const) {
        await terminal.resize(cols, rows);
      }
      const resized = await terminal.waitFacts("执行终端审批验收", (events) =>
        events.some(
          (event) => event.type === "approval_required" && event.approvalId === required.approvalId,
        ),
      );
      expect(eventsOf(resized).filter((event) => event.type === "approval_required")).toEqual([
        expect.objectContaining({ approvalId: required.approvalId }),
      ]);
      expect(eventsOf(resized).filter((event) => event.type === "approval_resolved")).toEqual([]);
      expect(existsSync(path.join(terminal.workspace, "approved.md"))).toBe(false);
      expect(terminal.requests).toHaveLength(1);
      terminal.send("\x1b[200~y\x1b[201~");
      await terminal.waitText("控制命令 > y");
      const approvalOffset = terminal.outputOffset();
      terminal.send("\x1b");
      await terminal.waitFor(
        () => terminal.outputOffset() > approvalOffset,
        "Esc 返回原审批后未重绘",
      );
      terminal.send(`/steer ${steering}\r`);
      await terminal.waitText("applied");
      const applied = await terminal.waitFacts("执行终端审批验收", (_events, records) =>
        records.some(
          (record) => record.kind === "control" && payloadOf(record).state === "applied",
        ),
      );
      expect(eventsOf(applied).filter((event) => event.type === "approval_resolved")).toEqual([]);
      expect(existsSync(path.join(terminal.workspace, "approved.md"))).toBe(false);
      expect(terminal.requests).toHaveLength(1);
      terminal.send("y");
      await terminal.waitText("审批与追加输入已完成");
      const run = await terminal.waitRun("执行终端审批验收", "succeeded");
      expect(await readFile(path.join(terminal.workspace, "approved.md"), "utf8")).toBe(
        "明确批准后写入",
      );
      const events = eventsOf(run);
      expect(events.filter((event) => event.type === "approval_resolved")).toEqual([
        expect.objectContaining({ approvalId: required.approvalId, decision: "allow" }),
      ]);
      expect(
        events.filter((event) => event.type === "tool_call" && event.tool === "write"),
      ).toHaveLength(1);
      const controls = run.records.filter((record) => record.kind === "control");
      expect(controls.map((record) => payloadOf(record).state)).toEqual(["accepted", "applied"]);
      expect(payloadOf(controls[0]!).controlId).toBe(payloadOf(controls[1]!).controlId);
      const receipt = events.find(
        (event) =>
          event.type === "input_receipt" && event.contentFingerprint === fingerprint(steering),
      );
      assert(receipt?.type === "input_receipt");
      const lifecycle = events.filter(
        (event) => "inputId" in event && event.inputId === receipt.inputId,
      );
      expect(lifecycle.map((event) => event.type)).toEqual([
        "input_receipt",
        "input_claimed",
        "input_completed",
      ]);
      const claimed = lifecycle.find((event) => event.type === "input_claimed");
      assert(claimed?.type === "input_claimed");
      expect(
        events.some((event) => event.type === "turn_end" && event.turnId === claimed.turnId),
      ).toBe(true);
      expect(terminal.requests).toHaveLength(2);
    },
  );
}, 40_000);

it("真实 PTY 逐 Call 核对耗时和真实 stored/blocked Artifact，下一 Run 复用 Call 仍独立 unknown", async () => {
  const service = await startMcpHttpServer();
  let alias = "";
  try {
    await withTerminal(
      "evidence",
      (request, ordinal) => {
        if (ordinal === 1) {
          expect(lastUser(request)).toBe("生成两份真实产物");
          const candidates =
            request.tools?.filter((tool) => tool.function.name.startsWith("mcp_")) ?? [];
          expect(candidates).toHaveLength(1);
          alias = candidates[0]!.function.name;
          return {
            text: "前\t…",
            calls: [
              { id: storedCall, name: alias, args: { value: safeValue } },
              { id: blockedCall, name: alias, args: { value: blockedValue } },
            ],
          };
        }
        if (ordinal === 2) {
          expect(
            JSON.stringify(request.messages.filter((message) => message.role === "tool")),
          ).not.toContain(blockedCanary);
          expect(request.messages.filter((message) => message.role === "tool")).toHaveLength(2);
          return { text: "两份真实产物已处理" };
        }
        expect(ordinal).toBe(3);
        expect(lastUser(request)).toBe("开始真实发送后取消");
        return { calls: [{ id: storedCall, name: alias, args: { value: false } }] };
      },
      {
        mcp: {
          servers: {
            remote: {
              transport: "streamable-http",
              url: service.url,
              allowedAddresses: ["127.0.0.1"],
            },
          },
        },
        agents: {
          main: {
            tools: [
              {
                mcp: { server: "remote", tool: "echo" },
                effect: { operations: ["network"], reversible: false },
                capability: {
                  effect: "network",
                  replay: "unknown",
                  concurrency: "parallel",
                  checkpoint: "none",
                  durability: "critical",
                },
              },
            ],
          },
        },
      },
      async (terminal) => {
        terminal.addSockets("mcp", service.sockets);
        terminal.send("生成两份真实产物\r");
        await terminal.waitText("两份真实产物已处理");
        const first = await terminal.waitRun("生成两份真实产物", "succeeded");
        const firstProjection = ProjectionEngine.project(first.records);
        const events = eventsOf(first);
        const calls = events.filter((event) => event.type === "tool_call" && event.tool === alias);
        expect(calls.map((event) => ("callId" in event ? event.callId : undefined))).toEqual([
          storedCall,
          blockedCall,
        ]);
        const artifacts = events.filter((event) => event.type === "artifact_created");
        expect(artifacts).toHaveLength(2);
        for (const [callId, status] of [
          [storedCall, "stored"],
          [blockedCall, "blocked"],
        ] as const) {
          const evidence = events.find(
            (event) => event.type === "tool_execution_evidence" && event.callId === callId,
          );
          assert(evidence?.type === "tool_execution_evidence");
          expect(evidence.execution.durationMs).toBeGreaterThanOrEqual(0);
          await terminal.waitFor(
            () =>
              callRows(terminal.compact(), callId, firstProjection.runId).some((row) =>
                containsText(row, `执行耗时 ${evidence.execution.durationMs}ms`),
              ),
            `Call ${callId} 未显示对应真实执行耗时`,
          );
          const artifact = artifacts.find((event) => event.callId === callId);
          assert(artifact?.type === "artifact_created");
          expect(artifact).toMatchObject({ agent: "main", callId, tool: alias, status });
          const location = status === "stored" ? artifact.relativePath : "已阻止保存，不能打开";
          assert(location);
          await terminal.waitFor(
            () =>
              containsText(
                terminal.compact(),
                `${artifact.artifactId} · ${status} · ${artifact.sizeBytes} bytes · ${location} · main · Call ${callId} · Run ${firstProjection.runId}`,
              ),
            "Artifact 显示与真正事实和来源身份不一致",
          );
          if (status === "stored") {
            assert(artifact.relativePath);
            const file = ownedPath(terminal.workspace, artifact.relativePath);
            const bytes = await readFile(file);
            expect(bytes.length).toBe(artifact.sizeBytes);
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
            expect(bytes.toString("utf8")).toContain(safeValue);
          } else expect(artifact.relativePath).toBeUndefined();
        }
        const stored = artifacts.find((artifact) => artifact.status === "stored");
        assert(stored?.relativePath);
        expect(
          (await readdir(path.join(terminal.workspace, ".coremind", "artifacts"))).filter((file) =>
            file.endsWith(".log"),
          ),
        ).toEqual([path.basename(stored.relativePath)]);
        // Facts 落盘早于会话收尾；产物查询须等待当前 Run 的真实界面就绪。
        await terminal.waitFor(() => {
          const output = terminal.compact().replace(/\s/gu, "");
          const source = output.lastIndexOf(firstProjection.runId!);
          const ready = output.lastIndexOf("输入就绪");
          return (
            source >= 0 &&
            ready > source &&
            ready > output.lastIndexOf("普通输入保留为草稿") &&
            !output.slice(ready).startsWith("输入就绪，按Enter发送草稿")
          );
        }, "当前 Run 已落盘，但界面尚未完成收尾并就绪");
        const listing = terminal.outputOffset();
        terminal.send("/artifacts\r");
        assert(firstProjection.snapshot);
        expect(
          firstProjection.snapshot.artifacts.map((artifact) => [
            artifact.artifactId,
            artifact.status,
          ]),
        ).toEqual(artifacts.map((artifact) => [artifact.artifactId, artifact.status]));
        const title = "本轮 Artifact：".replace(/\s/gu, "");
        const references = firstProjection.snapshot.artifacts
          .map((artifact) => {
            const location =
              artifact.status === "stored" ? artifact.relativePath : "已阻止保存，不能打开";
            assert(location);
            return `Artifact ${artifact.artifactId} · ${artifact.status} · ${artifact.sizeBytes} bytes · ${location}`;
          })
          .join("\n")
          .replace(/\s/gu, "");
        await terminal.waitFor(() => {
          const output = terminal.compact(listing).replace(/\s/gu, "");
          const heading = output.indexOf(title);
          return heading >= 0 && output.slice(heading + title.length).startsWith(references);
        }, "/artifacts 未在独有标题后返回两条连续、完整且无来源行尾的 canonical 引用");
        expect(terminal.compact()).not.toContain(blockedCanary);
        const priorBytes = first.raw;
        service.setMode("hang-call");
        const nextOutput = terminal.outputOffset();
        terminal.send("开始真实发送后取消\r");
        await terminal.waitFor(
          () =>
            service.records.filter(
              (record: { type: string; method?: string }) =>
                record.type === "request" && record.method === "tools/call",
            ).length >= 3,
          "取消前业务 tools/call 未真实到达",
        );
        expect(
          service.records.filter(
            (record: { type: string; method?: string }) =>
              record.type === "request" && record.method === "tools/call",
          ),
        ).toHaveLength(3);
        for (const [cols, rows] of [
          [120, 40],
          [40, 16],
          [80, 24],
        ] as const) {
          await terminal.resize(cols, rows);
        }
        terminal.send("/abort\r");
        const second = await terminal.waitRun("开始真实发送后取消", "aborted");
        const secondProjection = ProjectionEngine.project(second.records);
        expect(secondProjection.runId).not.toBe(firstProjection.runId);
        expect(
          eventsOf(second)
            .filter((event) => event.type === "effect_receipt" && event.callId === storedCall)
            .map((event) => (event.type === "effect_receipt" ? event.status : undefined)),
        ).toEqual(["started", "unknown"]);
        expect(eventsOf(second).filter((event) => event.type === "artifact_created")).toEqual([]);
        await terminal.waitFor(
          () =>
            callRows(terminal.compact(nextOutput), storedCall, secondProjection.runId).some(
              (row) =>
                row.includes("效果未知") &&
                (row.includes("执行已中止") || row.includes("未收到结果")),
            ),
          "第二 Run 的同名 Call 必须显示真实中止/未返回和 unknown",
        );
        const cancelledEvidence = eventsOf(second).find(
          (event) => event.type === "tool_execution_evidence" && event.callId === storedCall,
        );
        if (cancelledEvidence?.type === "tool_execution_evidence") {
          await terminal.waitFor(
            () =>
              callRows(terminal.compact(nextOutput), storedCall, secondProjection.runId).some(
                (row) => containsText(row, `执行耗时 ${cancelledEvidence.execution.durationMs}ms`),
              ),
            "第二 Run 不得借用先前 Call 耗时",
          );
        } else
          expect(
            callRows(terminal.compact(nextOutput), storedCall, secondProjection.runId).some((row) =>
              row.includes("执行耗时未记录"),
            ),
          ).toBe(true);
        expect(await readFile(first.file, "utf8")).toBe(priorBytes);
        expect(terminal.requests).toHaveLength(3);
      },
    );
  } finally {
    await service.close();
  }
}, 40_000);

it("真实 PTY 合并登录与取消，授权面板 resize 后粘贴取消只留稿，Enter 才关闭回调", async () => {
  const service = await startMcpAuthServer();
  try {
    await withTerminal(
      "authentication",
      () => {
        throw new Error("只验证登录取消，不能进入模型请求");
      },
      {
        mcp: { servers: { remote: service.config } },
        agents: { main: { mcpResources: { remote: ["fixture://first"] } } },
      },
      async (terminal) => {
        terminal.addSockets("auth", service.sockets);
        const waitAuthorization = async (offset: number) => {
          let selected: URL | undefined;
          await terminal.waitFor(() => {
            selected = authorizationFromDisplay(terminal.compact(offset));
            return selected !== undefined;
          }, "真实登录未显示完整授权链接");
          return selected!;
        };
        const noBusiness = async () => {
          expect(terminal.requests).toHaveLength(0);
          expect(
            service.records.some(
              (record: { type: string }) => record.type === "token" || record.type === "rpc",
            ),
          ).toBe(false);
          expect(await readRuns(terminal.workspace)).toEqual([]);
        };

        const firstOffset = terminal.outputOffset();
        terminal.send("/mcp login remote\r");
        const first = await waitAuthorization(firstOffset);
        const firstCallback = new URL(first.searchParams.get("redirect_uri")!);
        expect(await callbackListening(firstCallback)).toBe(true);
        await noBusiness();
        const firstCancel = terminal.outputOffset();
        terminal.send("/mcp cancel\r");
        await terminal.waitText("登录已取消", firstCancel);
        await terminal.waitFor(
          async () => !(await callbackListening(firstCallback)),
          "合并取消后原回调仍在监听",
        );
        await noBusiness();
        const firstChunks = await terminal.inputChunks();
        expect(
          firstChunks.some(
            (chunk) =>
              chunk.type === "read" &&
              Buffer.from(String(chunk.hex), "hex").toString("utf8").includes("/mcp cancel\r"),
          ),
          "粘贴发生前必须已真实读到合并取消块",
        ).toBe(true);

        const secondOffset = terminal.outputOffset();
        terminal.send("/mcp login remote\r");
        const second = await waitAuthorization(secondOffset);
        const secondCallback = new URL(second.searchParams.get("redirect_uri")!);
        expect(
          Boolean(
            second.searchParams.get("state") &&
              second.searchParams.get("state") !== first.searchParams.get("state"),
          ),
          "两次登录必须是真正独立事务",
        ).toBe(true);
        expect(await callbackListening(secondCallback)).toBe(true);
        for (const [cols, rows] of [
          [40, 16],
          [80, 24],
          [120, 40],
        ] as const) {
          await terminal.resize(cols, rows);
        }
        const pasted = terminal.outputOffset();
        terminal.send("\x1b[200~/mcp cancel\r\x1b[201~");
        await terminal.waitText("你 > /mcp cancel", pasted);
        expect(await callbackListening(secondCallback), "paste 只能留稿，原事务仍须真实等待").toBe(
          true,
        );
        await noBusiness();
        const confirmed = terminal.outputOffset();
        terminal.send("\r");
        await terminal.waitText("登录已取消", confirmed);
        await terminal.waitFor(
          async () => !(await callbackListening(secondCallback)),
          "独立 Enter 取消后原回调仍在监听",
        );
        await noBusiness();

        const chunks = await terminal.inputChunks();
        const reads = chunks
          .filter((chunk) => chunk.type === "read")
          .map((chunk) => Buffer.from(String(chunk.hex), "hex").toString("utf8"));
        expect(reads.filter((chunk) => chunk.includes("/mcp login remote\r"))).toHaveLength(2);
      },
    );
  } finally {
    await service.close();
  }
}, 40_000);

async function withTerminal(
  name: string,
  reply: Reply,
  extra: Record<string, unknown>,
  action: (terminal: Terminal) => Promise<void>,
) {
  expect(existsSync(cli), "必须先构建真实 CLI，测试不得自行生成产物").toBe(true);
  const cliSha256 = createHash("sha256")
    .update(await readFile(cli))
    .digest("hex");
  const workspace = await mkdtemp(path.join(tmpdir(), `coremind-terminal-pty-${name}-`));
  const requests: ModelRequest[] = [];
  const failures: unknown[] = [];
  const sockets = new Map<string, Set<Socket>>([["provider", new Set()]]);
  const sends: Array<{ sequence: number; text: string; hex: string }> = [];
  const sizes: Array<{ cols: number; rows: number; outputOffset: number }> = [];
  const deadline = performance.now() + 30_000;
  let terminal: pty.IPty | undefined;
  let exit: { exitCode: number; signal?: number } | undefined;
  let raw = "";
  let passed = false;
  let failure: unknown;
  let cleanupKilled = false;
  const inputLog = ownedPath(workspace, "stdin-chunks.jsonl");
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body) as ModelRequest;
        requests.push(parsed);
        sendResponse(response, reply(parsed, requests.length));
      } catch (error) {
        failures.push(error);
        response.writeHead(500).end();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.get("provider")!.add(socket);
    socket.once("close", () => sockets.get("provider")!.delete(socket));
  });
  const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    while (!(await predicate())) {
      if (failures.length) throw failures[0];
      if (Buffer.byteLength(raw, "utf8") > 8 * 1024 * 1024)
        throw new Error("PTY 输出超过固定 8MiB 上限");
      if (performance.now() >= deadline)
        throw new Error(`${label}；终端末尾：${stripVTControlCharacters(raw).slice(-1_000)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const compact = (offset = 0) =>
    stripVTControlCharacters(raw.slice(offset)).replace(/[\r\n]/gu, "");
  const send = (text: string) => {
    assert(terminal && !exit, "不能向已退出的 PTY 发送输入");
    sends.push({
      sequence: sends.length + 1,
      text,
      hex: Buffer.from(text, "utf8").toString("hex"),
    });
    terminal.write(text);
  };
  const waitFacts = async (
    prompt: string,
    predicate: (events: CoreMindEvent[], records: RunStateRecord[]) => boolean,
  ) => {
    let selected: RunEvidence | undefined;
    await waitFor(async () => {
      const runs = await readRuns(workspace);
      selected = runs.find((run) =>
        run.records.some(
          (record) => record.kind === "start" && payloadOf(record).initialPrompt === prompt,
        ),
      );
      return Boolean(selected && predicate(eventsOf(selected), selected.records));
    }, `未得到 ${prompt} 的预期真实事实`);
    return selected!;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const config = ownedPath(workspace, "coremind.json");
    await writeFile(
      config,
      JSON.stringify({
        schemaVersion: 2,
        name: "真实终端证据验收",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          model: "probe-model",
          apiKeyEnv: "COREMIND_TEST_API_KEY",
        },
        agents: { main: {} },
        permissions: { mode: "full", workspaceOnly: true, network: "allow" },
        runtime: { maxTurns: 5, maxRetries: 0, maxToolCalls: 5, runTimeoutMs: 15_000 },
        ...extra,
      }),
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "false",
      NO_COLOR: "1",
      TERM: "xterm-256color",
      COREMIND_TEST_API_KEY: "offline-test-only",
      COREMIND_PTY_INPUT_LOG: inputLog,
    };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    delete environment.COREMIND_WORKER_PATH;
    terminal = pty.spawn(
      process.execPath,
      ["--import", pathToFileURL(observer).href, cli, "chat", config],
      {
        cwd: workspace,
        cols: 80,
        rows: 24,
        encoding: "utf8",
        env: environment,
        ...(process.platform === "win32" ? { useConpty: true, conptyInheritCursor: false } : {}),
      },
    );
    const outputSubscription = terminal.onData((chunk) => {
      raw += chunk;
    });
    const exitSubscription = terminal.onExit((result) => {
      exit = result;
    });
    try {
      await waitFor(() => compact().includes("你 >"), "真实 TUI 输入框未就绪");
      // 首帧可能早于 Ink 的输入 effect，发送前须确认原生模式确已开启。
      await waitFor(
        async () =>
          (await readJsonLines(inputLog)).some(
            (entry) =>
              entry.type === "input_ready" &&
              entry.isRaw === true &&
              typeof entry.readableListeners === "number" &&
              entry.readableListeners > 0,
          ),
        "真实 TUI 原始输入未就绪",
      );
      await action({
        workspace,
        requests,
        send,
        waitFor,
        compact,
        waitFacts,
        outputOffset: () => raw.length,
        inputChunks: () => readJsonLines(inputLog),
        addSockets: (label, active) => sockets.set(label, active),
        waitText: (text, offset = 0) =>
          waitFor(() => containsText(compact(offset), text), `未显示 ${text}`),
        resize: async (cols, rows) => {
          const offset = raw.length;
          sizes.push({ cols, rows, outputOffset: offset });
          terminal!.resize(cols, rows);
          await waitFor(() => raw.length > offset, `真实 resize ${cols}×${rows} 未产生重绘`);
        },
        waitRun: async (prompt, status) => {
          const run = await waitFacts(prompt, (_events, records) =>
            records.some(
              (record) =>
                (record.kind === "finish" || record.kind === "pause") &&
                (payloadOf(record).outcome as { status?: string } | undefined)?.status === status,
            ),
          );
          const projection = ProjectionEngine.project(run.records);
          expect(projection.outcome?.status).toBe(status);
          expect(projection.snapshot?.outcome).toEqual(projection.outcome);
          return run;
        },
      });
      send("/exit\r");
      await waitFor(() => exit !== undefined, "明确退出后 CLI 未自然结束");
      expect(exit).toMatchObject({ exitCode: 0 });
      expect(exit!.signal ?? 0).toBe(0);
      await waitFor(
        () => [...sockets.values()].every((active) => active.size === 0),
        "CLI 自然退出后 socket 未收敛",
      );
      expect(failures).toEqual([]);
      const runs = await readRuns(workspace);
      for (const run of runs) {
        const projection = ProjectionEngine.project(run.records);
        expect(projection.outcome).toBeDefined();
        await writeFile(
          ownedPath(workspace, `${projection.runId}.projection.json`),
          JSON.stringify(projection),
          "utf8",
        );
      }
      passed = true;
    } finally {
      // 自然退出后才停止父端事件订阅；实际输出及 Facts 已先完成全部断言。
      if (exit) {
        outputSubscription.dispose();
        exitSubscription.dispose();
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const socketsBeforeFixtureCleanup = Object.fromEntries(
      [...sockets].map(([label, active]) => [label, active.size]),
    );
    if (terminal && !exit) {
      cleanupKilled = true;
      terminal.kill();
      const cleanupDeadline = performance.now() + 3_000;
      while (!exit && performance.now() < cleanupDeadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (process.platform === "win32" && terminal && exit) {
      // 当前 node-pty 的自然退出未释放父端专属排空线程；不再 kill 已退出的 CLI。
      const internal = terminal as unknown as {
        _agent?: { _conoutSocketWorker?: { dispose(): void } };
      };
      internal._agent?._conoutSocketWorker?.dispose();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mkdir(ownedPath(workspace, "evidence"), { recursive: true });
    await writeFile(ownedPath(workspace, "evidence/pty-raw.txt"), raw, "utf8");
    await writeFile(
      ownedPath(workspace, "evidence/send.jsonl"),
      sends.map((value) => JSON.stringify(value)).join("\n"),
      "utf8",
    );
    await writeFile(
      ownedPath(workspace, "evidence/model-requests.json"),
      JSON.stringify(requests),
      "utf8",
    );
    await writeFile(
      ownedPath(workspace, "evidence/proof.json"),
      JSON.stringify({
        passed: passed && !cleanupKilled,
        workspace,
        cliPath: cli,
        cliSha256,
        platform: process.platform,
        terminal: process.platform === "win32" ? "Windows ConPTY" : "POSIX PTY",
        sizes,
        naturalExit: Boolean(exit && !cleanupKilled),
        exit,
        cleanupKilled,
        socketsBeforeFixtureCleanup,
        modelRequests: requests.length,
        error: failure ? String(failure) : undefined,
      }),
      "utf8",
    );
    console.log(`真实 PTY 证据：${workspace}`);
  }
}

type Terminal = {
  workspace: string;
  requests: ModelRequest[];
  send(text: string): void;
  compact(offset?: number): string;
  outputOffset(): number;
  inputChunks(): Promise<Array<Record<string, unknown>>>;
  waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>;
  waitText(text: string, offset?: number): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  waitFacts(
    prompt: string,
    predicate: (events: CoreMindEvent[], records: RunStateRecord[]) => boolean,
  ): Promise<RunEvidence>;
  waitRun(prompt: string, status: string): Promise<RunEvidence>;
  addSockets(label: string, sockets: Set<Socket>): void;
};

function ownedPath(workspace: string, relative: string): string {
  const resolved = path.resolve(workspace, relative);
  const within = path.relative(path.resolve(workspace), resolved);
  assert(
    within && !path.isAbsolute(within) && within !== ".." && !within.startsWith(`..${path.sep}`),
    "证据路径必须严格位于自建工作区",
  );
  return resolved;
}

async function readJsonLines(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readRuns(workspace: string): Promise<RunEvidence[]> {
  const directory = ownedPath(workspace, ".coremind/runs");
  if (!existsSync(directory)) return [];
  return Promise.all(
    (await readdir(directory))
      .filter((file) => file.endsWith(".jsonl"))
      .map(async (name) => {
        const file = ownedPath(workspace, `.coremind/runs/${name}`);
        const raw = await readFile(file, "utf8");
        // 只投影已完整写入的 JSONL 行；最终终态断言仍要求实际完整终态 Fact。
        const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
        return {
          file,
          raw,
          records: complete
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as RunStateRecord),
        };
      }),
  );
}

function eventsOf(run: RunEvidence): CoreMindEvent[] {
  return run.records
    .filter((record) => record.kind === "event")
    .map((record) => payloadOf(record).event as CoreMindEvent);
}

function payloadOf(record: RunStateRecord): Record<string, unknown> {
  assert(
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload),
    "真实 Fact payload 必须是对象",
  );
  return record.payload as Record<string, unknown>;
}

function lastUser(request: ModelRequest): string {
  const content = [...request.messages]
    .reverse()
    .find((message) => message.role === "user")?.content;
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : "";
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function callRows(output: string, callId: string, runId: string): string[] {
  return output
    .split("⚙ ")
    .filter((row) => containsText(row, ` · Call ${callId} · Run ${runId} · `));
}

function containsText(output: string, expected: string): boolean {
  // Ink 折行会带容器缩进；只忽略显示空白，身份、标点、数值及先后顺序必须完整一致。
  return output.replace(/\s/gu, "").includes(expected.replace(/\s/gu, ""));
}

function authorizationFromDisplay(output: string): URL | undefined {
  // 只在本测试局部还原真实授权面板折行，URL 不写入 proof 或业务 Facts。
  const content = output.replace(/[│║\s]/gu, "");
  const found = /http:\/\/127\.0\.0\.1:\d+\/authorize\?[A-Za-z0-9%._~+&=-]+/u.exec(content);
  if (!found || !content.slice(found.index + found[0].length).includes("请手动打开链接"))
    return undefined;
  try {
    const url = new URL(found[0]);
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    if (
      callback.protocol !== "http:" ||
      callback.hostname !== "127.0.0.1" ||
      !callback.port ||
      !url.searchParams.get("state") ||
      !url.searchParams.get("code_challenge")
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function callbackListening(callback: URL): Promise<boolean> {
  assert(
    callback.protocol === "http:" && callback.hostname === "127.0.0.1" && callback.port,
    "只允许探测本测试的 loopback 回调",
  );
  return new Promise((resolve, reject) => {
    let listening = false;
    let failure: unknown;
    const socket = connect({ host: callback.hostname, port: Number(callback.port) });
    socket.once("connect", () => {
      listening = true;
      socket.destroy();
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNREFUSED") failure = error;
    });
    socket.setTimeout(1_000, () => {
      failure = new Error("loopback 回调探测超时");
      socket.destroy();
    });
    // 等探测连接真正关闭后才返回，不能把探测本身留成产品残留。
    socket.once("close", () => {
      if (failure) reject(failure);
      else resolve(listening);
    });
  });
}

function sendResponse(response: ServerResponse, result: ReturnType<Reply>): void {
  const calling = "calls" in result;
  const delta = calling
    ? {
        role: "assistant",
        ...(result.text === undefined ? {} : { content: result.text }),
        tool_calls: result.calls.map((call, index) => ({
          index,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      }
    : { role: "assistant", content: result.text };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [content, reason] of [
    [delta, null],
    [{}, calling ? "tool_calls" : "stop"],
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "terminal-pty", choices: [{ index: 0, delta: content, finish_reason: reason }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

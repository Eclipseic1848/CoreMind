import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChatSession,
  type CoreMindConfig,
  CoreMindRuntime,
  createMcpAuthentication,
  type McpAuthentication,
} from "coremind-ai";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { startMcpAuthServer } from "../../../test/fixtures/mcp-auth-server.mjs";
import { ApprovalQueue } from "./approval.js";
import { ChatTUI } from "./tui.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const uri = "fixture://first";

async function environment(turns = 1) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-auth-cli-"));
  const service = await startMcpAuthServer();
  const requests: Array<{
    messages: unknown[];
    tools: Array<{
      function: {
        name: string;
        parameters: { properties?: { uri?: { enum?: string[] } } };
      };
    }>;
  }> = [];
  const failures: unknown[] = [];
  const model = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body) as (typeof requests)[number];
        requests.push(parsed);
        expect(requests.length).toBeLessThanOrEqual(turns * 2);
        const first = requests.length % 2 === 1;
        const round = Math.ceil(requests.length / 2);
        if (first) {
          if (round === 1)
            expect(
              service.records.filter((record: { type: string }) => record.type === "rpc"),
            ).toEqual([]);
          else expect(service.sockets.size).toBe(0);
          expect(parsed.tools).toHaveLength(3);
        } else {
          expect(JSON.stringify(parsed.messages)).toContain("已授权资源");
        }
        const selected = first
          ? parsed.tools.filter((tool) =>
              tool.function.parameters.properties?.uri?.enum?.includes(uri),
            )
          : [];
        if (first) expect(selected).toHaveLength(1);
        const delta = first
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `auth-read-${round}`,
                  type: "function",
                  function: {
                    name: selected[0]!.function.name,
                    arguments: JSON.stringify({ uri }),
                  },
                },
              ],
            }
          : { role: "assistant", content: `认证资源读取完成 ${round}` };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [content, reason] of [
          [delta, null],
          [{}, first ? "tool_calls" : "stop"],
        ]) {
          response.write(
            `data: ${JSON.stringify({ id: `auth-${requests.length}`, choices: [{ index: 0, delta: content, finish_reason: reason }] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      } catch (error) {
        failures.push(error);
        response.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const config = {
    schemaVersion: 2,
    name: "认证入口验收",
    provider: {
      id: "probe",
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      model: "probe-model",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    mcp: { servers: { remote: service.config } },
    agents: { main: { mcpResources: { remote: [uri] } } },
    permissions: { mode: "full", workspaceOnly: true, network: "allow" },
    runtime: { maxTurns: 3, maxRetries: 0, maxToolCalls: 3, runTimeoutMs: 10_000 },
  } as CoreMindConfig;
  const configFile = path.join(directory, "coremind.json");
  await writeFile(configFile, JSON.stringify(config), "utf8");
  return {
    directory,
    service,
    config,
    configFile,
    requests,
    failures,
    async close() {
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** 输入仍由 CLI 唯一 readline 持有；显式 TTY 标志用于离线确定性验收。 */
function startCli(fixture: Awaited<ReturnType<typeof environment>>, args: string[]) {
  expect(existsSync(cliPath), "请先构建 CLI 产物").toBe(true);
  const bootstrap = `Object.defineProperty(process.stdin,'isTTY',{value:true,configurable:true});process.argv=[process.execPath,${JSON.stringify(cliPath)},...${JSON.stringify(args)}];await import(${JSON.stringify(new URL("../dist/cli.js", import.meta.url).href)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", bootstrap], {
    cwd: fixture.directory,
    env: { ...process.env, COREMIND_TEST_API_KEY: "offline-test-only", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, output: () => `${stdout}\n${stderr}` };
}

function authorizationUrl(text: string): string | undefined {
  // Ink 在每个折行两侧绘制边框，先还原行内容，再拼接 URL 的显示换行。
  const content = text
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*│\s?/u, "").replace(/\s?│\s*$/u, ""))
    .join("")
    .replace(/\s/gu, "");
  return content.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\?[A-Za-z0-9%._~+&=-]+/u)?.[0];
}

it.each(["run", "chat"] as const)(
  "编译 CLI %s 真实授权后在同一进程读取资源并自然退出",
  async (entry) => {
    expect(existsSync(cliPath), "请先构建 CLI 产物").toBe(true);
    const turns = entry === "chat" ? 2 : 1;
    const fixture = await environment(turns);
    const cli = startCli(
      fixture,
      entry === "run"
        ? ["run", fixture.configFile, "--mcp-login", "remote", "--prompt", "读取资源"]
        : ["chat", fixture.configFile, "--no-tui", "--quiet"],
    );
    try {
      if (entry === "chat") cli.child.stdin.write("/mcp login remote\n");
      await vi.waitFor(() => expect(authorizationUrl(cli.output())).toBeDefined(), {
        timeout: 15_000,
      });
      expect(fixture.requests).toEqual([]);
      const loginUrl = authorizationUrl(cli.output())!;
      expect(await fixture.service.completeAuthorization(loginUrl)).toBe(200);
      if (entry === "chat") {
        await vi.waitFor(() => expect(cli.output()).toContain("登录成功"), { timeout: 3_000 });
        cli.child.stdin.write("读取资源\n");
      }
      await vi.waitFor(() => expect(cli.output()).toContain("认证资源读取完成 1"), {
        timeout: 15_000,
      });
      if (entry === "chat") {
        await vi.waitFor(() => expect(cli.output().match(/你 >/gu)?.length).toBe(2), {
          timeout: 3_000,
        });
        await vi.waitFor(() => expect(fixture.service.sockets.size).toBe(0), { timeout: 3_000 });
        expect(
          fixture.service.records.filter((record: { type: string }) => record.type === "token"),
        ).toHaveLength(1);
        cli.child.stdin.write("再次读取资源\n");
        await vi.waitFor(() => expect(cli.output()).toContain("认证资源读取完成 2"), {
          timeout: 15_000,
        });
        await vi.waitFor(() => expect(cli.output().match(/你 >/gu)?.length).toBe(3), {
          timeout: 3_000,
        });
        await vi.waitFor(() => expect(fixture.service.sockets.size).toBe(0), { timeout: 3_000 });
        cli.child.stdin.write("/mcp logout remote\n");
        await vi.waitFor(() => expect(cli.output()).toContain("已清除当前进程的服务凭据"));
        cli.child.stdin.end("/exit\n");
      }
      const result = await cli.exited;
      expect(result, cli.output()).toEqual({ code: 0, signal: null });
      expect(fixture.requests).toHaveLength(turns * 2);
      expect(
        fixture.service.records.filter((record: { type: string }) => record.type === "token"),
      ).toEqual([expect.objectContaining({ valid: true, grant: "authorization_code" })]);
      expect(
        fixture.service.records.filter(
          (record: { type: string; method?: string }) =>
            record.type === "rpc" && record.method === "resources/read",
        ),
      ).toHaveLength(turns);
      expect(
        fixture.service.records.filter(
          (record: { type: string; method?: string }) =>
            record.type === "rpc" && record.method === "initialize",
        ),
      ).toHaveLength(turns);
      const runDirectory = path.join(fixture.directory, ".coremind", "runs");
      const files = await readdir(runDirectory, { recursive: true, encoding: "utf8" });
      const facts = await Promise.all(
        files
          .filter((file) => file.endsWith(".jsonl"))
          .map((file) => readFile(path.join(runDirectory, file), "utf8")),
      );
      expect(facts).toHaveLength(turns);
      const identities = new Set<string>();
      const callIds = new Set<string>();
      for (const journal of facts) {
        const records = journal
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(records.filter((record) => record.kind === "finish")).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({
              outcome: expect.objectContaining({ status: "succeeded" }),
            }),
          }),
        ]);
        const events = records
          .filter((record) => record.kind === "event")
          .map((record) => record.payload.event);
        const reads = events.filter(
          (event) => event.type === "tool_call" && event.args?.mcp?.operation === "resources/read",
        );
        expect(reads).toHaveLength(1);
        expect(reads[0].args.arguments).toEqual({ uri });
        expect(reads[0].args.mcp.serverIdentity).toMatch(/^[0-9a-f]{64}$/u);
        identities.add(reads[0].args.mcp.serverIdentity);
        callIds.add(reads[0].callId);
        expect(
          events
            .filter((event) => event.type === "effect_receipt" && event.callId === reads[0].callId)
            .map((event) => event.status),
        ).toEqual(["started", "committed"]);
      }
      expect(identities.size).toBe(1);
      expect(callIds).toEqual(
        new Set(Array.from({ length: turns }, (_value, index) => `auth-read-${index + 1}`)),
      );
      const privateProjection = JSON.stringify({ requests: fixture.requests, facts });
      expect(privateProjection).not.toMatch(
        /access-\d+-|refresh-[0-9a-f]|code_verifier|code_challenge|\/mcp login|\/authorize\?/u,
      );
      expect(cli.output()).not.toMatch(/access-\d+-|refresh-[0-9a-f]|code_verifier/u);
      expect(fixture.failures).toEqual([]);
      await vi.waitFor(() => expect(fixture.service.sockets.size).toBe(0), { timeout: 3_000 });
      const callback = new URL(loginUrl).searchParams.get("redirect_uri")!;
      await expect(
        fetch(callback, { headers: { connection: "close" }, redirect: "manual" }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "ECONNREFUSED" }),
      });
    } finally {
      if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGKILL");
      await cli.exited;
      await fixture.close();
    }
  },
  45_000,
);

it.each(["cancel", "eof"] as const)(
  "编译 CLI readline 授权等待时 %s 不换令牌且自然退出",
  async (stop) => {
    expect(existsSync(cliPath), "请先构建 CLI 产物").toBe(true);
    const fixture = await environment();
    const cli = startCli(fixture, ["chat", fixture.configFile, "--no-tui", "--quiet"]);
    try {
      cli.child.stdin.write("/mcp login remote\n");
      await vi.waitFor(() => expect(authorizationUrl(cli.output())).toBeDefined(), {
        timeout: 15_000,
      });
      if (stop === "cancel") {
        cli.child.stdin.write("/mcp cancel\n");
        await vi.waitFor(() => expect(cli.output()).toContain("登录已取消"), { timeout: 3_000 });
        cli.child.stdin.end("/exit\n");
      } else cli.child.stdin.end();
      expect(await cli.exited, cli.output()).toEqual({ code: 0, signal: null });
      expect(fixture.requests).toEqual([]);
      expect(
        fixture.service.records.some(
          (record: { type: string }) => record.type === "token" || record.type === "rpc",
        ),
      ).toBe(false);
      await vi.waitFor(() => expect(fixture.service.sockets.size).toBe(0), { timeout: 3_000 });
    } finally {
      if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGKILL");
      await cli.exited;
      await fixture.close();
    }
  },
  30_000,
);

it.each(["authorized", "cancel", "exit"] as const)(
  "Ink 使用真实认证事务 %s 时 URL 不入消息且可收尾",
  async (outcome) => {
    const fixture = await environment();
    const previousKey = process.env.COREMIND_TEST_API_KEY;
    process.env.COREMIND_TEST_API_KEY = "offline-test-only";
    let authentication: McpAuthentication | undefined;
    let rendered: ReturnType<typeof render> | undefined;
    try {
      authentication = await createMcpAuthentication({ config: fixture.config });
      const runtime = await CoreMindRuntime.create({
        config: fixture.config,
        cwd: fixture.directory,
        configDir: fixture.directory,
        mcpAuthentication: authentication,
      });
      const session = new ChatSession(runtime, "main");
      const chat = vi.spyOn(session, "chat");
      const onExit = vi.fn();
      const app = render(
        <ChatTUI
          title="真实认证"
          session={session}
          approvals={new ApprovalQueue(true)}
          mcp={{ authentication, config: fixture.config }}
          onExit={onExit}
        />,
      );
      rendered = app;
      const command = async (value: string) => {
        for (const character of value) app.stdin.write(character);
        await new Promise((resolve) => setTimeout(resolve, 30));
        app.stdin.write("\r");
      };
      await command("/mcp login remote");
      await vi.waitFor(() => expect(authorizationUrl(app.lastFrame() ?? "")).toBeDefined(), {
        timeout: 5_000,
      });
      expect(chat).not.toHaveBeenCalled();
      const url = authorizationUrl(app.lastFrame()!)!;
      if (outcome === "authorized") {
        const authorization = new URL(url);
        expect(authorization.searchParams.get("client_id"), app.lastFrame()).toBe(
          fixture.service.clientId,
        );
        expect(authorization.searchParams.get("resource"), app.lastFrame()).toBe(
          fixture.service.url,
        );
        expect(authorization.searchParams.get("scope"), app.lastFrame()).toBe(
          fixture.service.scopes.join(" "),
        );
        expect(await fixture.service.completeAuthorization(url)).toBe(200);
        await vi.waitFor(() => expect(app.lastFrame()).toContain("登录成功"));
        expect(app.lastFrame()).not.toContain("code_challenge");
        await command("读取资源");
        await vi.waitFor(() => expect(app.lastFrame()).toContain("认证资源读取完成"), {
          timeout: 15_000,
        });
        const turn = await chat.mock.results[0]!.value;
        expect(turn.run.outcome.status).toBe("succeeded");
        expect(
          JSON.stringify({ snapshot: turn.run.snapshot, requests: fixture.requests }),
        ).not.toMatch(/access-\d+-|refresh-[0-9a-f]|code_verifier|code_challenge|\/authorize\?/u);
        await command("/mcp logout remote");
        await vi.waitFor(() => expect(app.lastFrame()).toContain("已清除当前进程的服务凭据"));
      } else {
        await command(outcome === "cancel" ? "/mcp cancel" : "/exit");
        if (outcome === "exit") await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
        else await vi.waitFor(() => expect(app.lastFrame()).toContain("登录已取消"));
        expect(app.lastFrame()).not.toContain("code_challenge");
        expect(
          fixture.service.records.some((record: { type: string }) => record.type === "token"),
        ).toBe(false);
      }
      expect(chat).toHaveBeenCalledTimes(outcome === "authorized" ? 1 : 0);
      expect(fixture.failures).toEqual([]);
    } finally {
      rendered?.unmount();
      await authentication?.close();
      if (previousKey === undefined) delete process.env.COREMIND_TEST_API_KEY;
      else process.env.COREMIND_TEST_API_KEY = previousKey;
      await fixture.close();
    }
  },
  30_000,
);

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sdkUrl = new URL("../../coremind/dist/index.js", import.meta.url).href;
const cliPath = fileURLToPath(new URL("../../coremind-cli/dist/cli.js", import.meta.url));
const proof = "sandbox-lifecycle-proof";
const command = `printf '${proof}\\n' >> proof.txt; tail -n 1 proof.txt`;
const sdkHost = `
import { readFile } from "node:fs/promises";
import path from "node:path";
const { CoreMindRuntime, parseAndValidate } = await import(process.argv[1]);
const configFile = process.argv[2];
const { config } = parseAndValidate(JSON.parse(await readFile(configFile, "utf8")));
process.on("message", async (message) => {
  if (message === "exit") { process.disconnect(); return; }
  try {
    const runtime = await CoreMindRuntime.create({ config, configDir: path.dirname(configFile), cwd: path.dirname(configFile), initialPrompt: "执行 bash 验收" });
    const result = await runtime.run();
    process.send({ status: result.outcome.status, error: result.outcome.error, bashResults: result.trace.filter(({ event }) => event.type === "tool_result").map(({ event }) => ({ tool: event.tool, isError: event.isError })) });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    process.disconnect();
  }
});
process.send("ready");
`;

interface Host {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

async function bounded<T>(promise: Promise<T>, message: string, timeout = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function receive(host: Host, message?: string): Promise<unknown> {
  const controller = new AbortController();
  const reply = new Promise<unknown>((resolve, reject) => {
    host.child.once("message", resolve);
    controller.signal.addEventListener("abort", () => host.child.off("message", resolve));
    host.closed.then(() => reject(new Error(`SDK 在回复前退出：${host.output()}`)));
  });
  if (message) host.child.send(message);
  return bounded(reply, "等待 SDK 回复超时").finally(() => controller.abort());
}

function helpers(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.startsWith("coremind-seccomp-"))
    .map((name) => path.join(directory, name));
}

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "coremind-sandbox-lifecycle-"));
  const hosts: Host[] = [];
  const projects = new Map<string, { cwd: string; temporary: string; config: string }>();
  const observed = new Map<string, string[][]>();
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        const input = JSON.parse(body) as {
          model: string;
          messages: Array<{ role: string; content: unknown }>;
        };
        const project = projects.get(input.model);
        if (!project) throw new Error("收到未注册的模型夹具请求");
        const result = input.messages.at(-1);
        const finished = result?.role === "tool";
        if (finished) {
          expect(JSON.stringify(result.content)).toContain(proof);
          const paths = helpers(project.temporary);
          expect(paths).toHaveLength(1);
          expect(existsSync(path.join(paths[0]!, "apply-seccomp"))).toBe(true);
          observed.set(input.model, [...(observed.get(input.model) ?? []), paths]);
        }
        const delta = finished
          ? { role: "assistant", content: "验收完成" }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "bash-proof",
                  type: "function",
                  function: { name: "bash", arguments: JSON.stringify({ command, timeout: 5 }) },
                },
              ],
            };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of [
          { id: "sandbox", choices: [{ index: 0, delta, finish_reason: null }] },
          {
            id: "sandbox",
            choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }],
          },
          {
            id: "usage",
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ])
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });
  await bounded(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    "模型夹具启动超时",
  );
  const port = (server.address() as { port: number }).port;

  function start(name: string, sdk = true): Host {
    const cwd = path.join(root, name);
    const temporary = path.join(root, `${name}-tmp`);
    mkdirSync(cwd);
    mkdirSync(temporary);
    const config = path.join(cwd, "coremind.json");
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 2,
        name: "沙箱资源生命周期验收",
        provider: {
          id: "probe",
          model: name,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: "COREMIND_TEST_API_KEY",
        },
        agents: { main: { systemPrompt: "按要求执行 bash" } },
        tools: [{ id: "bash" }],
        permissions: { mode: "full", workspaceOnly: true, network: "deny" },
        runtime: { maxTurns: 2, maxRetries: 0, runTimeoutMs: 15_000 },
      }),
      "utf8",
    );
    projects.set(name, { cwd, temporary, config });
    const child = spawn(
      process.execPath,
      sdk
        ? ["--input-type=module", "--eval", sdkHost, sdkUrl, config]
        : [cliPath, "run", config, "--prompt", "执行 bash 验收", "--print"],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: temporary,
          COREMIND_TEST_API_KEY: "test-only",
        },
        detached: true,
        stdio: sdk ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => {
      output += String(error);
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    const host = { child, closed, output: () => output };
    hosts.push(host);
    return host;
  }

  return {
    start,
    observed,
    projects,
    async close() {
      for (const host of hosts) {
        if (host.child.exitCode === null && host.child.signalCode === null && host.child.pid) {
          try {
            process.kill(-host.child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
      await bounded(Promise.all(hosts.map((host) => host.closed)), "验收子进程回收超时", 5_000);
      server.closeAllConnections();
      await bounded(
        new Promise<void>((resolve) => server.close(() => resolve())),
        "模型夹具关闭超时",
        5_000,
      );
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform !== "linux")("Linux 已构建 Node 入口的沙箱资源归还", () => {
  it("SDK 跨 Run 复用，两个宿主分别只在自身正常退出时归还 helper", async () => {
    const test = await fixture();
    try {
      const a = test.start("host-a");
      expect(await receive(a)).toBe("ready");
      const b = test.start("host-b");
      expect(await receive(b)).toBe("ready");
      for (const host of [a, b, a]) {
        expect(await receive(host, "run"), host.output()).toMatchObject({
          status: "succeeded",
          bashResults: [{ tool: "bash", isError: false }],
        });
        expect(host.child.exitCode).toBeNull();
      }
      const firstA = test.observed.get("host-a")!;
      const firstB = test.observed.get("host-b")!;
      expect(firstA).toHaveLength(2);
      expect(firstA[1]).toEqual(firstA[0]);
      expect(firstB).toHaveLength(1);
      expect(helpers(test.projects.get("host-a")!.temporary)).toEqual(firstA[0]);
      expect(helpers(test.projects.get("host-b")!.temporary)).toEqual(firstB[0]);
      a.child.send("exit");
      expect(await bounded(a.closed, "SDK A 正常退出超时"), a.output()).toEqual({
        code: 0,
        signal: null,
      });
      expect(helpers(test.projects.get("host-a")!.temporary)).toEqual([]);
      expect(helpers(test.projects.get("host-b")!.temporary)).toEqual(firstB[0]);
      expect(b.child.exitCode).toBeNull();
      expect(await receive(b, "run"), b.output()).toMatchObject({
        status: "succeeded",
        bashResults: [{ tool: "bash", isError: false }],
      });
      expect(test.observed.get("host-b")).toEqual([firstB[0], firstB[0]]);
      expect(helpers(test.projects.get("host-b")!.temporary)).toEqual(firstB[0]);
      b.child.send("exit");
      expect(await bounded(b.closed, "SDK B 正常退出超时"), b.output()).toEqual({
        code: 0,
        signal: null,
      });
      for (const project of test.projects.values()) {
        expect(readFileSync(path.join(project.cwd, "proof.txt"), "utf8")).toBe(
          `${proof}\n${proof}\n`,
        );
        expect(helpers(project.temporary)).toEqual([]);
      }
    } finally {
      await test.close();
    }
  }, 90_000);

  it("CLI 实际执行 bash 后成功退出，先观测到 helper 再确认目录消失", async () => {
    const test = await fixture();
    try {
      const cli = test.start("cli", false);
      expect(await bounded(cli.closed, "CLI 正常退出超时"), cli.output()).toEqual({
        code: 0,
        signal: null,
      });
      expect(test.observed.get("cli")).toHaveLength(1);
      const project = test.projects.get("cli")!;
      expect(readFileSync(path.join(project.cwd, "proof.txt"), "utf8")).toBe(`${proof}\n`);
      expect(helpers(project.temporary)).toEqual([]);
    } finally {
      await test.close();
    }
  }, 30_000);
});

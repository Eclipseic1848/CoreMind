import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { createMcpStdioClient, type McpStdioClient } from "./mcp-stdio-client.js";
import { buildToolsWithExecutionEnvironment } from "./registry.js";

const fixture = path.resolve(process.cwd(), "test/fixtures/mcp-stdio-server.mjs");
const secret = "private-service-value-73629";

it("构造与未就绪调用零 I/O；静态注册表明确拒绝 MCP 引用", async () => {
  await withClient("normal", async (client, directory) => {
    expect(existsSync(path.join(directory, "records.jsonl"))).toBe(false);
    await expect(client.listTools()).rejects.toMatchObject({ code: "mcp_connection_unavailable" });
    expect(existsSync(path.join(directory, "records.jsonl"))).toBe(false);
    await expect(
      buildToolsWithExecutionEnvironment([{ mcp: { server: "server", tool: "echo" } }] as never, {
        cwd: directory,
        configDir: directory,
      }),
    ).rejects.toThrow("Run 内");
  });
});

it("分页保留完整 Schema 并冻结，伪造快照在远端执行前失败", async () => {
  await withClient("normal", async (client, directory) => {
    await client.connect();
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "write_once"]);
    expect(tools[0]!.inputSchema).toMatchObject({
      $defs: { value: {} },
      properties: { value: { $ref: "#/$defs/value" } },
      required: ["value"],
      additionalProperties: false,
    });
    expect(Object.isFrozen(tools[0]!.definition)).toBe(true);
    expect(Object.isFrozen(tools[0]!.inputSchema.properties)).toBe(true);
    expect(tools[0]!.schemaSha256).toMatch(/^[0-9a-f]{64}$/u);
    await expect(client.callTool({ ...tools[0]! }, { value: 1 })).rejects.toMatchObject({
      code: "mcp_invalid_tool",
    });
    expect(
      (await records(directory)).filter((record) => record.method === "tools/call"),
    ).toHaveLength(0);
  });
});

it.each([
  null,
  false,
  0,
  [1, null, false],
  { text: "原始对象", artifact: { relativePath: "outside" }, fullOutputPath: "outside" },
])("现代协议保留自然 JSON %j 且远端元数据不能伪装 Artifact", async (value) => {
  await withClient(
    "normal",
    async (client) => {
      await client.connect();
      const tool = (await client.listTools())[0]!;
      const result = await client.callTool(tool, { value });
      expect(result.details).toMatchObject({ mcp: { structuredContent: value } });
      expect(result.details).not.toHaveProperty("artifact");
      expect(result.details).not.toHaveProperty("fullOutputPath");
    },
    true,
  );
});

it("默认 legacy 保留合法 envelope，不擅自解包 result 字段", async () => {
  await withClient("normal", async (client, directory) => {
    await client.connect();
    const result = await client.callTool((await client.listTools())[0]!, { value: false });
    expect(result.details).toMatchObject({ mcp: { structuredContent: { result: false } } });
    expect(
      (await records(directory)).filter((record) => record.method === "server/discover"),
    ).toHaveLength(0);
  });
});

it("大结果只由本地 import 产生 Artifact，JSON 字节与摘要可回读", async () => {
  await withClient("normal", async (client, directory) => {
    await client.connect();
    const value = { text: "正文".repeat(12_000), artifact: "远端字段" };
    const result = await client.callTool((await client.listTools())[0]!, { value });
    const details = result.details as {
      artifact: { relativePath: string; sha256: string; sizeBytes: number };
    };
    expect(details.artifact.relativePath).toMatch(/^\.coremind\/artifacts\//u);
    const bytes = await readFile(path.join(directory, details.artifact.relativePath));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(details.artifact.sha256);
    expect(bytes.length).toBe(details.artifact.sizeBytes);
    expect(JSON.parse(bytes.toString("utf8")).mcp.structuredContent).toEqual(value);
    expect(result.text).toContain("Artifact:");
  });
});

it.each(["bad-json", "invalid-utf8", "oversize", "stderr", "unsupported"])(
  "%s 真实异常关闭连接且不重放工具",
  async (mode) => {
    await withClient(mode, async (client, directory) => {
      await client.connect();
      const tool = (await client.listTools())[0]!;
      await expect(client.callTool(tool, { value: "唯一输入" })).rejects.toHaveProperty("code");
      expect(
        (await records(directory)).filter((record) => record.method === "tools/call"),
      ).toHaveLength(1);
    });
  },
);

it.each(["secret-schema", "secret-result", "secret-key", "secret-error", "secret-stderr"])(
  "%s 本次秘密不进入结果、错误或 Artifact，未列宿主变量不透传",
  async (mode) => {
    const previous = process.env.COREMIND_MCP_UNLISTED;
    process.env.COREMIND_MCP_UNLISTED = "host-only";
    try {
      await withClient(
        mode,
        async (client, directory) => {
          await client.connect();
          const outcome = await (async () => {
            const tool = (await client.listTools())[0]!;
            return client.callTool(tool, { value: "正常结果" });
          })().catch((cause: Error & { code?: string }) => ({
            error: { name: cause.name, message: cause.message, code: cause.code },
          }));
          expect(JSON.stringify(outcome)).not.toContain(secret);
          if (mode !== "secret-stderr") expect(outcome).toHaveProperty("error");
          const log = await records(directory);
          expect(log).toContainEqual({ type: "environment", allowed: true, forbidden: false });
          const artifacts = path.join(directory, ".coremind", "artifacts");
          if (existsSync(artifacts)) expect(await readdir(artifacts)).toEqual([]);
        },
        false,
        { MCP_TEST_SECRET: secret },
      );
    } finally {
      if (previous === undefined) delete process.env.COREMIND_MCP_UNLISTED;
      else process.env.COREMIND_MCP_UNLISTED = previous;
    }
  },
);

it.each([
  { mode: "secret-number", sensitiveValue: "73629" },
  { mode: "secret-joined", sensitiveValue: "private-service-first\nprivate-service-second" },
])("$mode 序列化或拼接后的秘密在输出前阻断", async ({ mode, sensitiveValue }) => {
  await withClient(
    mode,
    async (client, directory) => {
      await client.connect();
      const tool = (await client.listTools())[0]!;
      const outcome = await client
        .callTool(tool, { value: "正常结果" })
        .catch((cause: Error & { code?: string }) => ({
          error: { name: cause.name, message: cause.message, code: cause.code },
        }));
      expect(outcome).toMatchObject({ error: { code: "mcp_secret_blocked" } });
      expect(JSON.stringify(outcome)).not.toContain(JSON.stringify(sensitiveValue).slice(1, -1));
      expect(
        (await records(directory)).filter((record) => record.method === "tools/call"),
      ).toHaveLength(1);
      const artifacts = path.join(directory, ".coremind", "artifacts");
      if (existsSync(artifacts)) expect(await readdir(artifacts)).toEqual([]);
    },
    false,
    { MCP_TEST_SECRET: sensitiveValue },
  );
});

it.each(["header-mismatch", "input-required"])(
  "现代 %s 不自动刷新目录或重发写工具",
  async (mode) => {
    await withClient(
      mode,
      async (client, directory) => {
        await client.connect();
        const tool = (await client.listTools()).find((entry) => entry.name === "write_once")!;
        await expect(client.callTool(tool, { value: "一次" })).rejects.toHaveProperty("code");
        const log = await records(directory);
        expect(log.filter((record) => record.method === "tools/list")).toHaveLength(2);
        expect(log.filter((record) => record.method === "tools/call")).toHaveLength(1);
      },
      true,
    );
  },
);

it("目录变化停止旧快照 dispatch，不后台 list 或误用旧批准", async () => {
  await withClient("change", async (client, directory) => {
    await client.connect();
    const tool = (await client.listTools())[0]!;
    await client.callTool(tool, { value: "第一次" });
    await expect(client.callTool(tool, { value: "不得再次发送" })).rejects.toMatchObject({
      code: "mcp_connection_unavailable",
    });
    const log = await records(directory);
    expect(log.filter((record) => record.method === "tools/list")).toHaveLength(2);
    expect(log.filter((record) => record.method === "tools/call")).toHaveLength(1);
  });
});

it("分页循环失败关闭；工具 isError 与协议错误独立", async () => {
  await withClient("page-loop", async (client) => {
    await client.connect();
    await expect(client.listTools()).rejects.toHaveProperty("code");
  });
  await withClient("tool-error", async (client) => {
    await client.connect();
    expect(
      (await client.callTool((await client.listTools())[0]!, { value: "工具失败" })).isError,
    ).toBe(true);
  });
});

it("关闭一个 owner 后独立连接仍能执行，跨 Client 快照不能调用", async () => {
  await withClient("normal", async (first) => {
    await withClient("normal", async (second) => {
      await first.connect();
      await second.connect();
      const firstTool = (await first.listTools())[0]!;
      const secondTool = (await second.listTools())[0]!;
      await first.close();
      expect((await second.callTool(secondTool, { value: "独立成功" })).text).toContain("独立成功");
      await expect(second.callTool(firstTool, { value: "跨连接" })).rejects.toMatchObject({
        code: "mcp_invalid_tool",
      });
    });
  });
});

async function withClient(
  mode: string,
  action: (client: McpStdioClient, directory: string) => Promise<void>,
  modern = false,
  env: Record<string, string> = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-mcp-client-"));
  const client = createMcpStdioClient({
    command: process.execPath,
    args: [fixture, path.join(directory, "records.jsonl"), mode],
    cwd: directory,
    env,
    sensitiveValues: Object.values(env),
    ...(modern ? { protocolVersion: "2026-07-28" } : {}),
    runEnvironment: createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    }),
    artifactStore: new ArtifactStore({ cwd: directory }),
  });
  const failures: unknown[] = [];
  try {
    await action(client, directory);
  } catch (cause) {
    failures.push(cause);
  }
  try {
    await client.close();
  } catch (cause) {
    failures.push(new Error("产品关闭失败", { cause }));
  }
  try {
    const started = (await records(directory)).find((record) => record.type === "started") as
      | { pid: number; childPid: number }
      | undefined;
    if (started) {
      try {
        await vi.waitFor(() => {
          expect(alive(started.pid)).toBe(false);
          expect(alive(started.childPid)).toBe(false);
        });
      } catch (cause) {
        failures.push(new Error("产品关闭后仍有自有进程", { cause }));
      }
      // 只有先记下产品清理失败，才兜底清理本格记录的 PID，不能用兜底制造通过。
      for (const pid of [started.childPid, started.pid])
        if (alive(pid)) {
          if (process.platform === "win32")
            spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
          else process.kill(pid, "SIGKILL");
        }
    }
  } catch (cause) {
    failures.push(new Error("读取或兜底清理本格进程失败", { cause }));
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (cause) {
    failures.push(new Error(`本格临时目录清理失败：${directory}`, { cause }));
  }
  if (failures.length) throw new AggregateError(failures, "本地 MCP 主流程与清理证据");
}

async function records(directory: string): Promise<Array<Record<string, unknown>>> {
  const file = path.join(directory, "records.jsonl");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw cause;
  }
}

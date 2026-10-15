import "../../../test/setup-env.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig, McpHttpServerConfig } from "coremind-config";
import type { McpAuthentication } from "coremind-tools";
import { expect, it, vi } from "vitest";
import { startMcpAuthServer } from "../../../test/fixtures/mcp-auth-server.mjs";
import { createMcpAuthentication } from "./mcp-authentication.js";
import { CoreMindRuntime, type CoreMindRuntimeOptions, type RunResult } from "./runtime.js";
import type { ToolApprovalRequest } from "./tool-policy.js";

it("headless 选中 OAuth 工具时明确暂停需认证，不启动登录或发模型/MCP请求", async () => {
  await withProject("tool", async (project) => {
    const result = await project.run();
    expect(result.outcome).toMatchObject({
      status: "paused",
      error: { code: "mcp_auth_required" },
    });
    expect(project.requests).toEqual([]);
    expect(project.service.records).toEqual([]);
  });
});

it("network deny 先于认证会话和受保护服务出站，显式 login 也不能放行", async () => {
  await withProject("tool", async (project) => {
    project.config.permissions!.network = "deny";
    const authentication = await project.authenticate();
    const onAuthorization = vi.fn();
    await expect(authentication.login("remote", { onAuthorization })).rejects.toMatchObject({
      code: "mcp_auth_failed",
    });
    const result = await project.run(authentication);
    expect(result.outcome).toMatchObject({
      status: "paused",
      finishReason: "tool_approval_denied",
    });
    expect(result.trace.some((entry) => entry.event.type === "policy_denied")).toBe(true);
    expect(onAuthorization).not.toHaveBeenCalled();
    expect(project.requests).toEqual([]);
    expect(project.service.records).toEqual([]);
  });
});

it("network ask 显式登录不批准业务，拒绝原审批时 MCP 和模型请求均为零", async () => {
  await withProject("tool", async (project) => {
    project.config.permissions!.network = "ask";
    const authentication = await project.authenticate();
    const authorization = await authentication.login("remote", {
      onAuthorization: async (request) => {
        expect(await project.service.completeAuthorization(request.authorizationUrl)).toBe(200);
      },
    });
    const before = project.service.records.length;
    const approvals: ToolApprovalRequest[] = [];
    const result = await project.run(authentication, async (request) => {
      approvals.push(request);
      return "deny";
    });
    expect(result.outcome).toMatchObject({
      status: "paused",
      finishReason: "tool_approval_denied",
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.args).toMatchObject({
      server: "remote",
      serverIdentity: authorization.serverIdentity,
      url: project.service.url,
      operation: "connect",
      oauth: {
        issuer: project.service.issuer,
        clientId: project.service.clientId,
        scopes: project.service.scopes,
      },
    });
    expect(project.service.records.slice(before)).toEqual([]);
    expect(project.requests).toEqual([]);
  });
});

it("network ask 合法批准后真实读取成功，连接和业务审批保持同一完整认证身份", async () => {
  await withProject("resource", async (project) => {
    project.config.permissions!.network = "ask";
    const authentication = await project.authenticate();
    const authorization = await authentication.login("remote", {
      onAuthorization: async (request) => {
        expect(await project.service.completeAuthorization(request.authorizationUrl)).toBe(200);
      },
    });
    const approvals: ToolApprovalRequest[] = [];
    const result = await project.run(authentication, async (request) => {
      approvals.push(request);
      return "allow";
    });
    expect(result.outcome.status).toBe("succeeded");
    const target = {
      server: "remote",
      serverIdentity: authorization.serverIdentity,
      url: project.service.url,
      oauth: {
        issuer: project.service.issuer,
        clientId: project.service.clientId,
        scopes: project.service.scopes,
      },
    };
    expect(
      approvals.some(
        (request) => (request.args as { operation?: unknown }).operation === "connect",
      ),
    ).toBe(true);
    expect(
      approvals.some(
        (request) =>
          (request.args as { mcp?: { operation?: unknown } }).mcp?.operation === "resources/read",
      ),
    ).toBe(true);
    for (const request of approvals) {
      const args = request.args as { mcp?: unknown };
      expect(args.mcp ?? args).toMatchObject(target);
      expect(request.argumentsFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(project.service.records.filter((record) => record.type === "token")).toHaveLength(1);
    expect(
      project.service.records.filter(
        (record) => record.type === "rpc" && record.method === "resources/read",
      ),
    ).toHaveLength(1);
  });
});

it("公开认证宿主跨两次真实 Run 复用，单 Run 收尾不注销且授权 URL 不入事实", async () => {
  await withProject("resource", async (project) => {
    const authentication = await project.authenticate();
    const authorization = await authentication.login("remote", {
      onAuthorization: async (request) => {
        expect(await project.service.completeAuthorization(request.authorizationUrl)).toBe(200);
      },
    });
    const results = [await project.run(authentication), await project.run(authentication)];
    expect(results.map((result) => result.outcome.status)).toEqual(["succeeded", "succeeded"]);
    expect(project.service.records.filter((record) => record.type === "token")).toHaveLength(1);
    expect(
      project.service.records.filter(
        (record) => record.type === "rpc" && record.method === "initialize",
      ),
    ).toHaveLength(2);
    expect(
      project.service.records.filter(
        (record) => record.type === "rpc" && record.method === "resources/read",
      ),
    ).toHaveLength(2);
    const calls = results
      .flatMap((result) => result.trace.map((entry) => entry.event))
      .filter((event) => event.type === "tool_call");
    expect(
      calls.some((event) => JSON.stringify(event).includes(authorization.serverIdentity)),
    ).toBe(true);
    expect(JSON.stringify({ results, requests: project.requests })).not.toMatch(
      /access-\d+-|refresh-|\/authorize\?/u,
    );
    await authentication.logout("remote");
    const before = project.service.records.length;
    const afterLogout = await project.run(authentication);
    expect(afterLogout.outcome).toMatchObject({
      status: "paused",
      error: { code: "mcp_auth_required" },
    });
    expect(project.service.records.slice(before)).toEqual([]);
  });
});

it("同名服务更换 client 不能使用原认证宿主身份", async () => {
  await withProject("resource", async (project) => {
    const authentication = await project.authenticate();
    await authentication.login("remote", {
      onAuthorization: async (request) => {
        expect(await project.service.completeAuthorization(request.authorizationUrl)).toBe(200);
      },
    });
    const server = project.config.mcp!.servers.remote!;
    if (server.transport !== "streamable-http" || !server.oauth) throw new Error("夹具类型错误");
    server.oauth.clientId = "another-public-client";
    const before = project.service.records.length;
    const result = await project.run(authentication);
    expect(result.outcome).toMatchObject({ status: "failed", error: { code: "mcp_auth_failed" } });
    expect(project.service.records.slice(before)).toEqual([]);
  });
});

type ModelRequest = {
  messages: Array<{ role: string }>;
  tools?: Array<{
    function: { name: string; parameters: { properties?: Record<string, unknown> } };
  }>;
};

async function withProject(
  kind: "tool" | "resource",
  check: (project: {
    config: CoreMindConfig;
    service: Awaited<ReturnType<typeof startMcpAuthServer>>;
    requests: ModelRequest[];
    authenticate(): Promise<McpAuthentication>;
    run(
      authentication?: McpAuthentication,
      approveTool?: CoreMindRuntimeOptions["approveTool"],
    ): Promise<RunResult>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-auth-runtime-"));
  const service = await startMcpAuthServer();
  const requests: ModelRequest[] = [];
  const modelErrors: unknown[] = [];
  const sessions: McpAuthentication[] = [];
  const model = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body) as ModelRequest;
        requests.push(parsed);
        const done = parsed.messages.at(-1)?.role === "tool";
        const read = parsed.tools?.find((tool) => tool.function.parameters.properties?.uri);
        if (!done && !read) throw new Error("夹具未获得精确资源读取声明");
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = done
          ? { role: "assistant", content: "公开结果" }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `auth-runtime-${requests.length}`,
                  type: "function",
                  function: {
                    name: read!.function.name,
                    arguments: JSON.stringify({ uri: "note://authorized" }),
                  },
                },
              ],
            };
        response.write(
          `data: ${JSON.stringify({ id: "auth-runtime", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ id: "auth-runtime", choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      } catch (error) {
        modelErrors.push(error);
        response.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const config: CoreMindConfig = {
    schemaVersion: 2,
    name: "宿主认证与原执行链",
    provider: {
      id: "probe",
      model: "probe-model",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    },
    mcp: { servers: { remote: structuredClone(service.config) as McpHttpServerConfig } },
    agents: {
      main:
        kind === "resource"
          ? { mcpResources: { remote: ["note://authorized"] } }
          : {
              tools: [
                {
                  mcp: { server: "remote", tool: "echo" },
                  effect: { operations: ["network"], reversible: false },
                  capability: {
                    effect: "network",
                    replay: "unknown",
                    concurrency: "run_serial",
                    checkpoint: "none",
                    durability: "critical",
                  },
                },
              ],
            },
    },
    permissions: { mode: "full", workspaceOnly: true, network: "allow" },
    runtime: { maxTurns: 3, maxRetries: 0, maxToolCalls: 8, runTimeoutMs: 10_000 },
  };
  try {
    await check({
      config,
      service,
      requests,
      async authenticate() {
        const authentication = await createMcpAuthentication({ config });
        sessions.push(authentication);
        return authentication;
      },
      async run(mcpAuthentication, approveTool) {
        const runtime = await CoreMindRuntime.create({
          config,
          configDir: directory,
          cwd: directory,
          initialPrompt: "读取明确授权资源",
          mcpAuthentication,
          approveTool,
        });
        const result = await runtime.run();
        expect(await runtime.waitForQuiescence()).toBe(true);
        return result;
      },
    });
    expect(modelErrors).toEqual([]);
    await Promise.all(sessions.map((authentication) => authentication.close()));
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
  } finally {
    await Promise.all(sessions.map((authentication) => authentication.close()));
    await service.close();
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

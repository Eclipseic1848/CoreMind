import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  BUILTIN_TOOL_IDS,
  type CoreMindConfig,
  type ToolConfig,
  type ToolEffectDeclaration,
} from "coremind-config";
import type { ArtifactStore, ToolCapabilityDeclaration } from "coremind-tools";
import {
  createMcpHttpClient,
  createMcpStdioClient,
  type ExecutionEnvironment,
  type McpHttpClient,
  type McpListedTool,
  type McpStdioClient,
  type McpStdioToolResult,
} from "coremind-tools/internal";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import { CoreMindError } from "./errors.js";
import type { SecretResolver } from "./provider.js";
import type { CoreMindToolDefinition, JsonObjectSchema } from "./public-tool.js";

type McpToolConfig = Extract<ToolConfig, { mcp: unknown }>;
type McpServerConfig = NonNullable<CoreMindConfig["mcp"]>["servers"][string];

export interface McpHostOperation {
  name: string;
  args: Record<string, unknown>;
  effect: ToolEffectDeclaration;
  capability: ToolCapabilityDeclaration;
  approvalDescription: string;
  invoke(): Promise<McpStdioToolResult>;
}

export interface PreparedMcpTool {
  definition: CoreMindToolDefinition;
  approvalDescription: string;
  readonly authorization: Readonly<Record<string, unknown>>;
}

export interface McpRunOptions {
  config: CoreMindConfig;
  configDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  secretResolver?: SecretResolver;
  environment: ExecutionEnvironment;
  signal?: AbortSignal;
  artifactStore: ArtifactStore;
}

interface PrepareMcpTools {
  agentName: string;
  executionId: string;
  signal?: AbortSignal;
  executeHost(operation: McpHostOperation): Promise<McpStdioToolResult>;
  reservedToolNames?: readonly string[];
}

const BASE_ENVIRONMENT_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
];
const HOST_CAPABILITY: ToolCapabilityDeclaration = {
  effect: "process",
  replay: "unknown",
  concurrency: "run_serial",
  checkpoint: "unsupported",
  durability: "critical",
};

/** 仅持有本 Run 的私有连接；连接与目录动作仍须由宿主完整 Harness 准入。 */
export function createMcpRun(options: McpRunOptions) {
  const controller = new AbortController();
  const owners = new Set<McpStdioClient | McpHttpClient>();
  const executions = new Map<string, { agentName: string; promise: Promise<PreparedMcpTool[]> }>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const assertOpen = (signal?: AbortSignal): void => {
    if (closed) throw new CoreMindError("tool_execution_failed", "本 Run 的本地服务已经关闭");
    signal?.throwIfAborted();
  };

  const prepareExecution = async (request: PrepareMcpTools): Promise<PreparedMcpTool[]> => {
    const signal = AbortSignal.any([
      controller.signal,
      ...(options.signal ? [options.signal] : []),
      ...(request.signal ? [request.signal] : []),
    ]);
    assertOpen(signal);
    const agent = options.config.agents[request.agentName];
    if (!agent) throw new CoreMindError("unknown_agent", "本地服务准备引用了未知 Agent");
    const effective = (agent.tools?.length ?? 0) > 0 ? agent.tools! : (options.config.tools ?? []);
    const selected = structuredClone(
      effective.filter((tool): tool is McpToolConfig => "mcp" in tool),
    );
    const grouped = new Map<string, McpToolConfig[]>();
    for (const tool of selected) {
      if (!options.config.mcp?.servers[tool.mcp.server])
        throw new CoreMindError("invalid_tool", "本地工具引用了未知服务");
      const group = grouped.get(tool.mcp.server) ?? [];
      if (group.some((previous) => previous.mcp.tool === tool.mcp.tool))
        throw new CoreMindError("invalid_tool", "同一 Agent 重复选择了本地服务工具");
      group.push(tool);
      grouped.set(tool.mcp.server, group);
    }
    const reserved = new Set<string>([...BUILTIN_TOOL_IDS, ...(request.reservedToolNames ?? [])]);
    const prepared: PreparedMcpTool[] = [];
    const resources = agent.mcpResources ?? {};
    const serverNames = new Set([
      ...grouped.keys(),
      ...Object.keys(resources).filter((name) => resources[name]!.length > 0),
    ]);
    for (const serverName of serverNames) {
      const selections = grouped.get(serverName) ?? [];
      const resourceUris = [...(resources[serverName] ?? [])];
      const configuredServer = options.config.mcp?.servers[serverName];
      if (!configuredServer) throw new CoreMindError("invalid_tool", "MCP 引用了未知服务");
      const server = structuredClone(configuredServer);
      if (resourceUris.length > 0 && server.transport !== "streamable-http")
        throw new CoreMindError("invalid_tool", "资源授权仅支持 Streamable HTTP 服务");
      const identity = await identifyServer(serverName, server);
      assertOpen(signal);
      const target = freezeJson({ ...identity.target, serverIdentity: identity.sha256 });
      const connectName = alias("connect", serverName, identity.sha256);
      const listName = alias("list", serverName, identity.sha256);
      for (const name of [connectName, listName]) {
        if (reserved.has(name))
          throw new CoreMindError("invalid_tool", "本地服务操作与已有工具冲突");
        reserved.add(name);
      }
      let client: McpStdioClient | McpHttpClient | undefined;
      let connection: Promise<McpStdioClient | McpHttpClient> | undefined;
      const connect = (): Promise<McpStdioClient | McpHttpClient> => {
        if (connection) return connection;
        connection = (async () => {
          await request.executeHost({
            name: connectName,
            args: { ...target, operation: "connect" },
            effect: {
              operations: [server.transport === "stdio" ? "process" : "network"],
              reversible: false,
            },
            capability: {
              ...HOST_CAPABILITY,
              effect: server.transport === "stdio" ? "process" : "network",
              concurrency: server.transport === "stdio" ? "run_serial" : "parallel",
              checkpoint: server.transport === "stdio" ? "unsupported" : "none",
            },
            approvalDescription: describeTarget(target, "建立连接"),
            invoke: async () => {
              assertOpen(signal);
              if (server.transport === "stdio" && "command" in target) {
                const { env, sensitiveValues } = await resolveEnvironment(server, options);
                assertOpen(signal);
                if ((await identifyServer(serverName, server)).sha256 !== identity.sha256)
                  throw new CoreMindError(
                    "tool_capability_conflict",
                    "本地服务目标在批准后发生变化",
                  );
                assertOpen(signal);
                client = createMcpStdioClient({
                  command: target.command,
                  args: target.argv,
                  cwd: target.cwd,
                  env,
                  runEnvironment: options.environment,
                  signal,
                  protocolVersion: server.protocolVersion ?? "legacy",
                  sensitiveValues,
                  artifactStore: options.artifactStore,
                });
              } else if (server.transport === "streamable-http" && "url" in target) {
                const { headers, sensitiveValues } = await resolveHeaders(server, options);
                assertOpen(signal);
                client = createMcpHttpClient({
                  url: server.url,
                  headers,
                  allowedAddresses: server.allowedAddresses,
                  allowedResourceUris: resourceUris,
                  runEnvironment: options.environment,
                  signal,
                  protocolVersion: server.protocolVersion ?? "legacy",
                  sensitiveValues,
                  artifactStore: options.artifactStore,
                });
              } else throw new CoreMindError("invalid_tool", "MCP 服务类型与身份不一致");
              // 在第一个连接 await 前登记，初始化失败和并发关闭也能找到自有资源。
              owners.add(client);
              await client.connect(signal);
              assertOpen(signal);
              return {
                text: "本地服务连接已建立",
                details: {
                  mcp: {
                    server: serverName,
                    serverIdentity: identity.sha256,
                    status: "connected",
                    environment: client.environmentSummary,
                  },
                },
              };
            },
          });
          assertOpen(signal);
          if (!client)
            throw new CoreMindError("tool_execution_failed", "宿主没有执行已准入的连接动作");
          return client;
        })();
        return connection;
      };
      if (selections.length > 0) {
        const connectedClient = await connect();
        let catalog: readonly McpListedTool[] | undefined;
        await request.executeHost({
          name: listName,
          args: { ...target, operation: "list", tools: selections.map((tool) => tool.mcp.tool) },
          effect: {
            operations: [server.transport === "stdio" ? "external" : "network"],
            reversible: false,
          },
          capability: {
            ...HOST_CAPABILITY,
            effect: server.transport === "stdio" ? "external" : "network",
            concurrency: server.transport === "stdio" ? "run_serial" : "parallel",
            checkpoint: server.transport === "stdio" ? "unsupported" : "none",
          },
          approvalDescription: describeTarget(target, "读取工具目录"),
          invoke: async () => {
            assertOpen(signal);
            catalog = await connectedClient.listTools(signal);
            assertOpen(signal);
            return {
              text: "本地工具目录已读取",
              details: {
                mcp: {
                  server: serverName,
                  serverIdentity: identity.sha256,
                  toolCount: catalog.length,
                },
              },
            };
          },
        });
        assertOpen(signal);
        if (!catalog)
          throw new CoreMindError("tool_execution_failed", "宿主没有执行已准入的目录动作");
        const listedTools: readonly McpListedTool[] = catalog;
        for (const selection of selections) {
          const matches = listedTools.filter((tool) => tool.name === selection.mcp.tool);
          if (matches.length !== 1)
            throw new CoreMindError("invalid_tool", "本地服务目录缺少唯一的已选择工具");
          const listed = matches[0]!;
          const authorization = freezeJson({
            ...target,
            tool: listed.name,
            schemaSha256: listed.schemaSha256,
            definitionSha256: fingerprintEffectReceiptValue(listed.definition),
            effect: selection.effect,
            capability: selection.capability,
          });
          const name = alias(serverName, listed.name, fingerprintEffectReceiptValue(authorization));
          if (reserved.has(name))
            throw new CoreMindError("invalid_tool", "本地工具别名与已有工具冲突");
          reserved.add(name);
          const approvalDescription = describeTarget(authorization, `调用原始工具 ${listed.name}`);
          prepared.push({
            authorization,
            approvalDescription,
            definition: {
              name,
              description: `${listed.description || listed.name}（本地服务 ${serverName} / ${listed.name}）`,
              parameters: structuredClone(listed.inputSchema) as JsonObjectSchema,
              effect: selection.effect,
              capability: selection.capability,
              execute: async (args, context) => {
                const callSignal = AbortSignal.any([
                  signal,
                  ...(context.signal ? [context.signal] : []),
                ]);
                assertOpen(callSignal);
                return connectedClient.callTool(listed, args, callSignal);
              },
            },
          });
        }
      }
      for (const operation of [
        "resources/list",
        "resources/templates/list",
        "resources/read",
      ] as const) {
        if (resourceUris.length === 0) break;
        const capability: ToolCapabilityDeclaration = {
          effect: "network",
          replay: "unknown",
          concurrency: "parallel",
          checkpoint: "none",
          durability: "critical",
        };
        const authorization = freezeJson({ ...target, operation, resourceUris, capability });
        const name = alias(
          serverName,
          operation.replaceAll("/", "_"),
          fingerprintEffectReceiptValue(authorization),
        );
        if (reserved.has(name)) throw new CoreMindError("invalid_tool", "MCP 资源工具别名冲突");
        reserved.add(name);
        const read = operation === "resources/read";
        prepared.push({
          authorization,
          approvalDescription: describeTarget(authorization, `资源操作 ${operation}`),
          definition: {
            name,
            description: `MCP 资源 ${operation}（服务 ${serverName}；仅当前 Agent 精确授权 URI）`,
            parameters: {
              type: "object",
              properties: read ? { uri: { type: "string", enum: resourceUris } } : {},
              ...(read ? { required: ["uri"] } : {}),
              additionalProperties: false,
            },
            effect: { operations: ["network"], reversible: false },
            capability,
            execute: async (args, context) => {
              const callSignal = AbortSignal.any([
                signal,
                ...(context.signal ? [context.signal] : []),
              ]);
              assertOpen(callSignal);
              if (
                args === null ||
                typeof args !== "object" ||
                Array.isArray(args) ||
                Object.keys(args).some((key) => !read || key !== "uri") ||
                (read && (typeof args.uri !== "string" || !resourceUris.includes(args.uri)))
              )
                throw new CoreMindError(
                  "invalid_tool",
                  "MCP 资源参数不在当前 Agent 的精确授权范围内",
                );
              // 连接属于执行；单个调用取消只结束自己的等待，不撤销其他合法调用。
              const resourceClient = (await waitForMcpConnection(
                connect(),
                callSignal,
              )) as McpHttpClient;
              assertOpen(callSignal);
              if (operation === "resources/list") return resourceClient.listResources(callSignal);
              if (operation === "resources/templates/list")
                return resourceClient.listResourceTemplates(callSignal);
              return resourceClient.readResource(args.uri as string, callSignal);
            },
          },
        });
      }
    }
    return prepared;
  };

  return {
    prepare(request: PrepareMcpTools): Promise<PreparedMcpTool[]> {
      if (closed)
        return Promise.reject(
          new CoreMindError("tool_execution_failed", "本 Run 的本地服务已经关闭"),
        );
      const existing = executions.get(request.executionId);
      if (existing) {
        return existing.agentName === request.agentName
          ? existing.promise
          : Promise.reject(
              new CoreMindError("tool_capability_conflict", "同一执行身份不能改绑 Agent"),
            );
      }
      const promise = prepareExecution(request);
      executions.set(request.executionId, { agentName: request.agentName, promise });
      return promise;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      controller.abort("本 Run 的本地服务关闭");
      closing = Promise.allSettled(
        [...owners].map((client) => Promise.resolve().then(() => client.close())),
      ).then((results) => {
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length > 0)
          throw Object.assign(
            new CoreMindError("environment_terminate_failed", "本 Run 的本地服务未全部完成关闭"),
            { cause: new AggregateError(failures.map((result) => result.reason)) },
          );
      });
      return closing;
    },
  };
}

async function identifyServer(serverName: string, server: McpServerConfig) {
  if (server.transport === "streamable-http") {
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw new CoreMindError("invalid_tool", "MCP HTTP URL 无效");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new CoreMindError(
        "invalid_tool",
        "MCP HTTP URL 必须是无凭据、查询和片段的固定 HTTP(S) 目标",
      );
    const target = {
      server: serverName,
      transport: server.transport,
      url: url.href,
      headerReferences: Object.fromEntries(
        Object.entries(server.headers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      allowedAddresses: [...(server.allowedAddresses ?? [])].sort(),
      protocolVersion: server.protocolVersion ?? "legacy",
    };
    return { target, sha256: fingerprintEffectReceiptValue(target) };
  }
  if (!path.isAbsolute(server.command) || !path.isAbsolute(server.cwd))
    throw new CoreMindError("invalid_tool", "本地服务命令与工作目录必须为绝对路径");
  const command = await realpath(server.command);
  const cwd = await realpath(server.cwd);
  if (!(await stat(command)).isFile() || !(await stat(cwd)).isDirectory())
    throw new CoreMindError("invalid_tool", "本地服务目标不是程序文件或工作目录");
  const scripts: Array<{ argumentIndex: number; path: string; sha256: string }> = [];
  for (const [argumentIndex, argument] of (server.args ?? []).entries()) {
    const candidate =
      argument.startsWith("-") && argument.includes("=")
        ? argument.slice(argument.indexOf("=") + 1)
        : argument;
    if (
      candidate.startsWith("-") ||
      !/\.(?:[cm]?js|py|pyw|sh|bash|rb|pl|ps1|cmd|bat)$/iu.test(candidate)
    )
      continue;
    const script = await realpath(path.resolve(cwd, candidate));
    if (!(await stat(script)).isFile())
      throw new CoreMindError("invalid_tool", "本地服务脚本不是普通文件");
    scripts.push({ argumentIndex, path: script, sha256: await hashFile(script) });
  }
  const target = {
    server: serverName,
    command,
    commandSha256: await hashFile(command),
    argv: [...(server.args ?? [])],
    cwd,
    scripts,
    envReferences: structuredClone(server.env ?? {}),
    protocolVersion: server.protocolVersion ?? "legacy",
  };
  return { target, sha256: fingerprintEffectReceiptValue(target) };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function resolveEnvironment(
  server: Extract<McpServerConfig, { transport: "stdio" }>,
  options: McpRunOptions,
) {
  const env: Record<string, string> = Object.create(null);
  const hostValue = (name: string) =>
    process.platform === "win32"
      ? Object.entries(options.env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
      : options.env[name];
  for (const name of BASE_ENVIRONMENT_KEYS) {
    const value = hostValue(name);
    if (value !== undefined && !value.startsWith("()")) env[name] = value;
  }
  const sensitiveValues: string[] = [];
  for (const [name, reference] of Object.entries(server.env ?? {})) {
    let value: string | undefined;
    try {
      value =
        "env" in reference
          ? hostValue(reference.env)
          : await options.secretResolver?.resolve(reference.secretRef);
    } catch {
      throw new CoreMindError("secret_reference_unresolved", "本地服务环境引用无法解析");
    }
    if (typeof value !== "string" || value.trim().length === 0)
      throw new CoreMindError("secret_reference_unresolved", "本地服务环境引用为空或无法解析");
    if (process.platform === "win32") {
      for (const key of Object.keys(env))
        if (key.toUpperCase() === name.toUpperCase()) delete env[key];
    }
    env[name] = value;
    sensitiveValues.push(value);
  }
  return { env, sensitiveValues };
}

async function resolveHeaders(
  server: Extract<McpServerConfig, { transport: "streamable-http" }>,
  options: McpRunOptions,
) {
  const headers: Record<string, string> = Object.create(null);
  const sensitiveValues: string[] = [];
  for (const [name, reference] of Object.entries(server.headers ?? {})) {
    let value: string | undefined;
    try {
      value =
        typeof reference === "string"
          ? reference
          : "env" in reference
            ? options.env[reference.env]
            : await options.secretResolver?.resolve(reference.secretRef);
    } catch {
      throw new CoreMindError("secret_reference_unresolved", "MCP HTTP Header 引用无法解析");
    }
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      /[\r\n]/u.test(value) ||
      value.includes("\0")
    )
      throw new CoreMindError(
        "secret_reference_unresolved",
        "MCP HTTP Header 引用为空、无效或无法解析",
      );
    const headerValue = value.trim();
    headers[name] = headerValue;
    if (typeof reference !== "string") {
      sensitiveValues.push(value, headerValue);
      const token =
        name.toLowerCase() === "authorization"
          ? /^(?:Bearer|Basic)\s+(.+)$/iu.exec(headerValue)?.[1]
          : undefined;
      if (token) sensitiveValues.push(token);
    }
  }
  return { headers, sensitiveValues };
}

function waitForMcpConnection<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function alias(server: string, tool: string, sha256: string): string {
  const short = (value: string, length: number) =>
    value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, length);
  return `mcp_${short(server, 8)}_${short(tool, 12)}_${sha256.slice(0, 32)}`;
}

function describeTarget(target: Record<string, unknown>, action: string): string {
  if (typeof target.url === "string")
    return `${action}：${String(target.server)}；HTTP ${target.url}；身份 ${String(target.serverIdentity)}`;
  return `${action}：${String(target.server)}；程序 ${String(target.command)}；目录 ${String(target.cwd)}；身份 ${String(target.serverIdentity)}`;
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

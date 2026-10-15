import { isIP } from "node:net";
import path from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  type CoreMindConfig,
  CoreMindConfigSchema,
  type McpToolConfig,
  type WorkflowStep,
} from "./schema/config.js";
import type { McpHttpServerConfig } from "./schema/mcp.js";
import { CustomProviderSchema } from "./schema/provider.js";
import { toolEffectOperationsForCapability } from "./schema/tools.js";

export type ConfigValidationErrorCode = "invalid_config";

/** 配置校验失败（含可读的中文字段路径） */
export class ConfigValidationError extends Error {
  readonly code: ConfigValidationErrorCode = "invalid_config";

  /** 校验错误明细列表 */
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[]) {
    super(message);
    this.name = "ConfigValidationError";
    this.details = details;
  }
}

/** 校验配置并填充默认值；结构错误抛 ConfigValidationError（中文可读） */
export function validateConfig(data: unknown): CoreMindConfig {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigValidationError("配置内容必须是对象（YAML 映射或 JSON 对象）", []);
  }

  const record = data as Record<string, unknown>;
  if ("version" in record && !("schemaVersion" in record)) {
    const details = ["旧字段 version 已停用，请删除 version 并添加 schemaVersion: 2"];
    throw new ConfigValidationError(`配置格式已升级：${details[0]}`, details);
  }

  validateRawToolDeclarations(record);
  validateCustomProviderFields(record);
  validateProviderHeaderReferences(record);

  if (!Value.Check(CoreMindConfigSchema, data)) {
    const details: string[] = [];
    for (const error of Value.Errors(CoreMindConfigSchema, data)) {
      const path = error.path === "" ? "根配置" : error.path.slice(1).replaceAll("/", ".");
      details.push(`${path}：${error.message}`);
    }
    throw new ConfigValidationError(
      `配置校验失败，共 ${details.length} 处问题：\n  - ${details.join("\n  - ")}`,
      details,
    );
  }

  validateMcpConfiguration(data as CoreMindConfig);
  const config = Value.Parse(CoreMindConfigSchema, data) as CoreMindConfig;
  // TypeBox 不遍历没有自身 default 的 Record 值，单独补齐服务协议。
  for (const server of Object.values(config.mcp?.servers ?? {})) {
    server.protocolVersion ??= "legacy";
  }
  if (config.workflow && config.loop) {
    const detail = "workflow 与 loop 只能选择一种，不能同时配置";
    throw new ConfigValidationError(detail, [detail]);
  }
  validateWorkflowStepIds(config.workflow ?? []);
  validateLoopAgents(config);
  validateDelegationTargets(config);
  validateTelemetry(config);
  return config;
}

function validateDelegationTargets(config: CoreMindConfig): void {
  const knownAgents = new Set(Object.keys(config.agents));
  const details: string[] = [];
  for (const [parentName, agent] of Object.entries(config.agents)) {
    const delegation = agent.delegation;
    if (!delegation) continue;
    const maxDescendants = delegation.limits?.maxDescendants ?? 32;
    if (delegation.budget.descendants > maxDescendants) {
      details.push(
        `agents.${parentName}.delegation.budget.descendants：不能超过层级上限 ${maxDescendants}`,
      );
    }
    for (const [targetName, target] of Object.entries(delegation.targets)) {
      const path = `agents.${parentName}.delegation.targets.${targetName}`;
      if (targetName === parentName) {
        details.push(`${path}：父 Agent 不能委派给自身`);
      } else if (!knownAgents.has(targetName)) {
        details.push(`${path}：引用了未定义的 Agent`);
      }
      for (const key of Object.keys(delegation.budget) as (keyof typeof delegation.budget)[]) {
        const reserved = key === "descendants" ? target.budget[key] + 1 : target.budget[key];
        if (reserved > delegation.budget[key]) {
          details.push(`${path}.budget.${key}：不能超过父 Agent 的委派预算池`);
        }
      }
    }
  }
  if (details.length > 0) {
    throw new ConfigValidationError(`配置校验失败：${details.join("；")}`, details);
  }
}

function validateProviderHeaderReferences(record: Record<string, unknown>): void {
  const provider = record.provider;
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) return;
  const headers = (provider as Record<string, unknown>).headers;
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return;

  const details: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const reference = value as Record<string, unknown>;
    const keys = Object.keys(reference);
    const validEnv =
      keys.length === 1 && typeof reference.env === "string" && reference.env.length > 0;
    const validSecretRef =
      keys.length === 1 &&
      typeof reference.secretRef === "string" &&
      reference.secretRef.length > 0;
    if (!validEnv && !validSecretRef) {
      details.push(`provider.headers.${name}：必须是非空 env 或 secretRef 引用`);
    }
  }
  if (details.length > 0) {
    throw new ConfigValidationError(`配置校验失败：${details.join("；")}`, details);
  }
}

function validateCustomProviderFields(record: Record<string, unknown>): void {
  const provider = record.provider;
  if (
    provider === null ||
    typeof provider !== "object" ||
    Array.isArray(provider) ||
    !("baseUrl" in provider)
  ) {
    return;
  }

  const allowed = propertiesOf(CustomProviderSchema);
  const details = Object.keys(provider)
    .filter((key) => !allowed.has(key))
    .map((key) => `provider.${key}：自定义 Provider 不支持该字段`);
  if (details.length > 0) {
    throw new ConfigValidationError(`配置校验失败：${details.join("；")}`, details);
  }
}

function validateTelemetry(config: CoreMindConfig): void {
  const telemetry = config.telemetry;
  if (!telemetry || telemetry.mode === undefined || telemetry.mode === "DISABLED") return;
  if (!telemetry.endpoint) {
    const detail = `telemetry.endpoint：${telemetry.mode} 模式必须显式配置 HTTP(S) endpoint`;
    throw new ConfigValidationError(`配置校验失败：${detail}`, [detail]);
  }
}

function validateLoopAgents(config: CoreMindConfig): void {
  if (!config.loop) return;
  const knownAgents = new Set(Object.keys(config.agents));
  const actions = [
    ["planning", config.loop.planning],
    ["execute", config.loop.execute],
    ["verify", config.loop.verify],
    ["repair", config.loop.repair],
  ] as const;
  const details = actions.flatMap(([name, action]) =>
    action && "agent" in action && !knownAgents.has(action.agent)
      ? [`loop.${name}.agent 引用了未定义的 Agent：${action.agent}`]
      : [],
  );
  if (details.length > 0) {
    throw new ConfigValidationError(`配置校验失败：${details.join("；")}`, details);
  }
}

function configuredToolLists(
  record: Record<string, unknown>,
): Array<{ prefix: string; tools: unknown }> {
  const locations: Array<{ prefix: string; tools: unknown }> = [
    { prefix: "tools", tools: record.tools },
  ];
  if (
    record.agents !== null &&
    typeof record.agents === "object" &&
    !Array.isArray(record.agents)
  ) {
    for (const [name, agent] of Object.entries(record.agents as Record<string, unknown>)) {
      if (agent !== null && typeof agent === "object" && !Array.isArray(agent)) {
        locations.push({
          prefix: `agents.${name}.tools`,
          tools: (agent as Record<string, unknown>).tools,
        });
      }
    }
  }
  return locations;
}

function validateRawToolDeclarations(record: Record<string, unknown>): void {
  for (const location of configuredToolLists(record)) {
    if (!Array.isArray(location.tools)) continue;
    for (const [index, tool] of location.tools.entries()) {
      if (tool === null || typeof tool !== "object" || Array.isArray(tool)) continue;
      if ("exposure" in tool) {
        if (tool.exposure !== "direct" && tool.exposure !== "deferred") {
          const detail = `${location.prefix}.${index}.exposure：必须是 direct 或 deferred`;
          throw new ConfigValidationError(`配置校验失败：${detail}`, [detail]);
        }
        if (tool.exposure === "deferred" && record.schemaVersion !== 3) {
          const detail = `${location.prefix}.${index}.exposure：deferred 必须显式配置 schemaVersion: 3`;
          throw new ConfigValidationError(`配置校验失败：${detail}`, [detail]);
        }
      }
      if ("mcp" in tool && ("id" in tool || "path" in tool)) {
        // 旧分支允许额外字段，必须在清理前阻断混合引用。
        const detail = `${location.prefix}.${index}：MCP 引用不能同时包含 id 或 path`;
        throw new ConfigValidationError(`配置校验失败：${detail}`, [detail]);
      }
      if ("path" in tool && !("effect" in tool)) {
        const detail = `${location.prefix}.${index}.effect：自定义工具必须声明副作用`;
        throw new ConfigValidationError(`配置校验失败：${detail}`, [detail]);
      }
    }
  }
}

function validateMcpConfiguration(config: CoreMindConfig): void {
  const servers = config.mcp?.servers ?? {};
  const details: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const prefix = `mcp.servers.${name}`;
    if (server.transport === "streamable-http") {
      validateMcpHttpServer(server, prefix, details);
      continue;
    }
    if (!path.isAbsolute(server.command)) details.push(`${prefix}.command：必须是固定绝对路径`);
    if (!path.isAbsolute(server.cwd)) details.push(`${prefix}.cwd：必须是固定绝对路径`);
    if (process.platform === "win32") {
      const keys = new Set<string>();
      for (const key of Object.keys(server.env ?? {})) {
        const folded = key.toUpperCase();
        if (keys.has(folded)) details.push(`${prefix}.env：Windows 环境键不能仅大小写不同`);
        keys.add(folded);
      }
    }
  }

  for (const [agentName, agent] of Object.entries(config.agents)) {
    for (const serverName of Object.keys(agent.mcpResources ?? {})) {
      const prefix = `agents.${agentName}.mcpResources.${serverName}`;
      const server = servers[serverName];
      if (!Object.hasOwn(servers, serverName)) details.push(`${prefix}：引用了未声明的 MCP 服务`);
      else if (server?.transport !== "streamable-http")
        details.push(`${prefix}：资源选择仅支持 streamable-http 服务`);
    }
  }

  for (const location of configuredToolLists(config)) {
    if (!Array.isArray(location.tools)) continue;
    const selected = new Set<string>();
    for (const [index, tool] of location.tools.entries()) {
      if (tool === null || typeof tool !== "object" || !("mcp" in tool)) continue;
      const ref = tool as McpToolConfig;
      const prefix = `${location.prefix}.${index}`;
      if (!Object.hasOwn(servers, ref.mcp.server)) {
        details.push(`${prefix}.mcp.server：引用了未声明的 MCP 服务`);
      }
      const identity = JSON.stringify([ref.mcp.server, ref.mcp.tool]);
      if (selected.has(identity)) details.push(`${prefix}.mcp：不能重复选择同一服务工具`);
      selected.add(identity);

      const boundary = toolEffectOperationsForCapability(ref.capability.effect)[0];
      const mutable = ref.effect.operations.filter((operation) => operation !== "read");
      const consistent =
        ref.capability.effect === "none"
          ? mutable.length === 0
          : mutable.length === 1 && mutable[0] === boundary;
      if (!consistent) details.push(`${prefix}.effect：副作用必须与 capability.effect 一致`);
      if (
        (ref.capability.effect === "workspace" || ref.capability.effect === "unknown") &&
        ref.capability.checkpoint === "none"
      ) {
        details.push(`${prefix}.capability.checkpoint：workspace/unknown 不能声明 none`);
      }
    }
  }
  if (details.length > 0) {
    throw new ConfigValidationError(`配置校验失败：${details.join("；")}`, details);
  }
}

const MCP_RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "proxy-connection",
  "upgrade",
  "proxy-authorization",
  "mcp-session-id",
  "dpop",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "last-event-id",
  "accept",
  "content-type",
]);

/** 这里只检查静态语法与固定目标，不解析 DNS、Header 引用或建立连接。 */
function validateMcpHttpTarget(
  server: Pick<McpHttpServerConfig, "url" | "allowedAddresses">,
  prefix: string,
  details: string[],
  urlField = "url",
): void {
  const addresses = new Set<string>();
  for (const [index, address] of (server.allowedAddresses ?? []).entries()) {
    const normalized = normalizeMcpAddress(address);
    if (normalized === undefined) {
      details.push(`${prefix}.allowedAddresses.${index}：必须是无区域标记的精确 IP 字面量`);
    } else {
      if (addresses.has(normalized)) details.push(`${prefix}.allowedAddresses：地址不能重复`);
      addresses.add(normalized);
    }
  }
  let url: URL | undefined;
  try {
    url = new URL(server.url);
  } catch {
    details.push(`${prefix}.${urlField}：必须是固定 HTTP(S) URL`);
  }
  if (url) {
    const authority = /^[^:]+:\/\/([^/?#]*)/u.exec(server.url)?.[1] ?? "";
    if (
      !/^https?:\/\//iu.test(server.url) ||
      [...server.url].some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === "\\",
      ) ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      authority.includes("@") ||
      server.url.includes("?") ||
      server.url.includes("#")
    ) {
      details.push(
        `${prefix}.${urlField}：仅允许无凭据、query、fragment 或控制字符的固定 HTTP(S) URL`,
      );
    }
    if (url.protocol === "http:") {
      // 使用原始主机部分拒绝整数、缩写等会被 URL 自动改写的隐式 loopback。
      const rawHost = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^:/?#]+)(?::[0-9]+)?(?:\/|$)/iu.exec(
        server.url,
      )?.[1];
      const address = rawHost ? normalizeMcpAddress(rawHost.replace(/^\[|\]$/gu, "")) : undefined;
      if (
        address === undefined ||
        (address !== "::1" && !address.startsWith("127.")) ||
        !addresses.has(address)
      ) {
        details.push(
          `${prefix}.${urlField}：HTTP 仅支持显式 allowedAddresses 中的 loopback IP 字面目标`,
        );
      }
    }
  }
}

function validateMcpHttpServer(
  server: McpHttpServerConfig,
  prefix: string,
  details: string[],
): void {
  validateMcpHttpTarget(server, prefix, details);
  if (server.oauth) {
    validateMcpHttpTarget(
      { url: server.oauth.issuer, allowedAddresses: server.oauth.allowedAddresses },
      `${prefix}.oauth`,
      details,
      "issuer",
    );
    if (Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === "authorization"))
      details.push(`${prefix}.oauth：不能同时配置 OAuth 与 Authorization Header`);
  }
  const headerNames = new Set<string>();
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    const folded = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || name !== name.trim())
      details.push(`${prefix}.headers：Header 名称必须是合法 token`);
    if (headerNames.has(folded)) details.push(`${prefix}.headers：Header 名不能仅大小写不同`);
    headerNames.add(folded);
    if (MCP_RESERVED_HEADERS.has(folded))
      details.push(`${prefix}.headers：不能覆盖传输保留 Header`);
    if (
      typeof value === "string" &&
      [...value].some(
        (character) =>
          (character.charCodeAt(0) < 32 && character.charCodeAt(0) !== 9) ||
          character.charCodeAt(0) === 127,
      )
    )
      details.push(`${prefix}.headers：Header 值不能包含控制字符`);
  }
}

function normalizeMcpAddress(address: string): string | undefined {
  const version = isIP(address);
  if (version === 0 || address.includes("%")) return undefined;
  if (version === 4) return address;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/u.exec(normalized);
  if (!mapped) return normalized;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

function validateWorkflowStepIds(steps: WorkflowStep[]): void {
  const ids = new Set<string>();
  const visit = (items: WorkflowStep[]) => {
    for (const step of items) {
      if (ids.has(step.id)) {
        const detail = `workflow 步骤 id 重复：${step.id}`;
        throw new ConfigValidationError(detail, [detail]);
      }
      ids.add(step.id);
      if (step.type === "parallel") visit(step.steps);
      if (step.type === "if") {
        visit(step.then);
        visit(step.else ?? []);
      }
      if (step.type === "switch") {
        for (const branch of Object.values(step.cases)) visit(branch);
        visit(step.default ?? []);
      }
    }
  };
  visit(steps);
}

/**
 * 检查顶层与 agents 级别是否存在未知字段（额外字段），
 * 供调用方以告警形式提示（不阻断执行，对新手友好）。
 */
export function findUnknownKeys(data: unknown): string[] {
  const warnings: string[] = [];
  if (data === null || typeof data !== "object") return warnings;

  // 顶层未知字段
  const top = data as Record<string, unknown>;
  const topProps = propertiesOf(CoreMindConfigSchema);
  for (const key of Object.keys(top)) {
    if (!topProps.has(key)) warnings.push(`顶层存在未知字段：${key}（已忽略）`);
  }

  // agents 内部未知字段
  const agents = top.agents;
  if (agents !== null && typeof agents === "object" && !Array.isArray(agents)) {
    const agentSchema = (CoreMindConfigSchema.properties as Record<string, TSchema>).agents;
    // agents 是 Type.Record 类型：值 schema 编译在 patternProperties 里（TRecord 无 .properties）
    const patterns = (agentSchema as { patternProperties?: Record<string, TSchema> })
      ?.patternProperties;
    const recordValue = patterns ? Object.values(patterns)[0] : undefined;
    const agentProps = recordValue ? propertiesOf(recordValue) : new Set<string>();
    for (const [name, agent] of Object.entries(agents as Record<string, unknown>)) {
      if (agent === null || typeof agent !== "object") continue;
      for (const key of Object.keys(agent as Record<string, unknown>)) {
        if (!agentProps.has(key)) warnings.push(`agents.${name} 存在未知字段：${key}（已忽略）`);
      }
    }
  }
  return warnings;
}

function propertiesOf(schema: TSchema): Set<string> {
  const props = (schema as { properties?: Record<string, TSchema> }).properties;
  return new Set(props ? Object.keys(props) : []);
}

/** 便捷入口：解析 + 校验 + 未知字段告警，一次完成 */
export function parseAndValidate(data: unknown): { config: CoreMindConfig; warnings: string[] } {
  const warnings = findUnknownKeys(data);
  const config = validateConfig(data);
  return { config, warnings };
}

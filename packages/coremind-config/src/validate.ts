import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type CoreMindConfig, CoreMindConfigSchema, type WorkflowStep } from "./schema/config.js";
import { CustomProviderSchema } from "./schema/provider.js";

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

  validateCustomToolEffects(record);
  validateCustomProviderFields(record);

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

  const config = Value.Parse(CoreMindConfigSchema, data) as CoreMindConfig;
  if (config.workflow && config.loop) {
    const detail = "workflow 与 loop 只能选择一种，不能同时配置";
    throw new ConfigValidationError(detail, [detail]);
  }
  validateWorkflowStepIds(config.workflow ?? []);
  validateLoopAgents(config);
  validateTelemetry(config);
  return config;
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
    action && !knownAgents.has(action.agent)
      ? [`loop.${name}.agent 引用了未定义的 Agent：${action.agent}`]
      : [],
  );
  if (details.length > 0) {
    throw new ConfigValidationError(`配置校验失败：${details.join("；")}`, details);
  }
}

function validateCustomToolEffects(record: Record<string, unknown>): void {
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
  for (const location of locations) {
    if (!Array.isArray(location.tools)) continue;
    for (const [index, tool] of location.tools.entries()) {
      if (
        tool !== null &&
        typeof tool === "object" &&
        !Array.isArray(tool) &&
        "path" in tool &&
        !("effect" in tool)
      ) {
        const detail = `${location.prefix}.${index}.effect：自定义工具必须声明副作用`;
        throw new ConfigValidationError(`配置校验失败：${detail}`, [detail]);
      }
    }
  }
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

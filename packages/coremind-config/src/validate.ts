import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type CoreMindConfig, CoreMindConfigSchema, type WorkflowStep } from "./schema/config.js";

/** 配置校验失败（含可读的中文字段路径） */
export class ConfigValidationError extends Error {
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
  validateWorkflowStepIds(config.workflow ?? []);
  return config;
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

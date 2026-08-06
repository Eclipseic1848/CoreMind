import { Type } from "@sinclair/typebox";

/**
 * 工作流步骤（简化编排，不做 DAG/循环）：
 * - prompt  / call   ：派发任务给某 agent（call 语义为委托，输入进其会话）
 * - parallel          ：并行执行子步骤
 * - if / switch       ：条件分支（条件仅支持 ==、!=、contains 与真值判定）
 * 支持嵌套（parallel/if/switch 内部可再含步骤），运行时以深度护栏限制。
 */
export const WorkflowStepSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Object({
      id: Type.String({ minLength: 1 }),
      type: Type.Literal("prompt"),
      agent: Type.String({ minLength: 1, description: "引用 agents 下定义的 agent 名字" }),
      input: Type.String({ description: "任务输入，支持 {{变量}} 插值" }),
      saveAs: Type.Optional(Type.String({ description: "步骤输出保存到 outputs 的键名" })),
    }),
    Type.Object({
      id: Type.String({ minLength: 1 }),
      type: Type.Literal("call"),
      agent: Type.String({ minLength: 1 }),
      input: Type.String({ description: "委托输入，支持 {{变量}} 插值" }),
      saveAs: Type.Optional(Type.String()),
    }),
    Type.Object({
      id: Type.String({ minLength: 1 }),
      type: Type.Literal("parallel"),
      steps: Type.Array(Self),
      saveAs: Type.Optional(Type.String({ description: "各子步骤输出的聚合文本" })),
    }),
    Type.Object({
      id: Type.String({ minLength: 1 }),
      type: Type.Literal("if"),
      condition: Type.String({ description: "条件表达式，如 {{changes.text}} contains 无" }),
      then: Type.Array(Self),
      else: Type.Optional(Type.Array(Self)),
    }),
    Type.Object({
      id: Type.String({ minLength: 1 }),
      type: Type.Literal("switch"),
      on: Type.String({ description: "要判定的变量名，如 changes.text" }),
      cases: Type.Record(Type.String(), Type.Array(Self), { description: "命中值 → 步骤数组" }),
      default: Type.Optional(Type.Array(Self)),
    }),
  ]),
);

import { type Static, Type } from "@sinclair/typebox";

/** Loop 中一次由 Agent 执行的有界动作。 */
export const LoopActionSchema = Type.Object({
  agent: Type.String({ minLength: 1, description: "引用 agents 下定义的 Agent 名称" }),
  input: Type.String({ minLength: 1, description: "支持 Loop 变量插值的输入模板" }),
});

/** 验证动作以 passIf 明确决定是否完成，不能只依赖流畅的最终文字。 */
export const LoopVerificationSchema = Type.Object({
  agent: Type.String({ minLength: 1 }),
  input: Type.String({ minLength: 1 }),
  passIf: Type.String({
    minLength: 1,
    description: "验证文本条件；{{text}} 指验证 Agent 的输出",
  }),
  evidence: Type.Optional(
    Type.Object(
      {
        mode: Type.Literal("runtime"),
        regressionCommand: Type.String({ minLength: 1 }),
        minSuccessfulTestCommands: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 20, default: 2 }),
        ),
        requireCheckpoint: Type.Optional(Type.Boolean({ default: true })),
        requireDiffReview: Type.Optional(Type.Boolean({ default: true })),
      },
      {
        description:
          "由 Runtime 工具结果、Checkpoint 与 Diff 元数据决定验证，不接受模型口头声明代替证据",
      },
    ),
  ),
});

/** 显式验证—修复 Loop；状态机实现属于 Runtime 内部细节。 */
export const LoopConfigSchema = Type.Object({
  planning: Type.Optional(LoopActionSchema),
  execute: LoopActionSchema,
  verify: LoopVerificationSchema,
  repair: LoopActionSchema,
  maxIterations: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, default: 3, description: "最多验证轮数" }),
  ),
  maxRepairs: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 99, default: 2, description: "最多修复次数" }),
  ),
  maxRepeatedAction: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 20, default: 2, description: "相同进展指纹上限" }),
  ),
  onFailure: Type.Optional(
    Type.Union([Type.Literal("repair"), Type.Literal("pause"), Type.Literal("fail")], {
      default: "repair",
    }),
  ),
  onExhausted: Type.Optional(
    Type.Union([Type.Literal("pause"), Type.Literal("fail")], { default: "fail" }),
  ),
});

export type LoopActionConfig = Static<typeof LoopActionSchema>;
export type LoopVerificationConfig = Static<typeof LoopVerificationSchema>;
export type LoopConfig = Static<typeof LoopConfigSchema>;

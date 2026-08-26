import type { WorkflowStep } from "coremind-config";
import type { AgentDriver } from "./agent-driver.js";
import { CoreMindError } from "./errors.js";
import { type CoreMindEvent, extractAgentError, extractText } from "./events.js";

/** 单个步骤的输出 */
export interface StepOutput {
  text: string;
  metadata: { agent: string; stepId: string };
}

export interface CompletedWorkflowStep {
  output: StepOutput;
  saveAs?: string;
}

export interface OrchestratorOptions {
  /**
   * agent 工厂：按名字创建独立实例（多 agent 按名字调用）。
   * 每个步骤使用独立实例执行——步骤之间通过 {{变量}} 传递结果，
   * 避免并发冲突，同时天然防止共享消息状态的竞态。
   */
  createAgent: (name: string, stepId?: string) => AgentDriver | undefined;
  /** 事件转发 */
  events: (event: CoreMindEvent) => void;
  /** 首条用户输入，注册为 {{prompt}} 变量 */
  initialPrompt?: string;
  signal?: AbortSignal;
  /** 嵌套深度护栏（默认 8） */
  maxDepth?: number;
  /** 总步骤数护栏（默认 100） */
  maxSteps?: number;
  /** 单步骤超时毫秒（默认 300000 = 5 分钟；0 = 不超时） */
  stepTimeoutMs?: number;
  /** 工作流全局重试次数上限（默认 3） */
  maxRetries?: number;
  /** 恢复前已消耗的工作流重试次数。 */
  initialRetryCount?: number;
  /** 从 RunState 恢复出的稳定步骤；这些步骤不会重复执行。 */
  completedSteps?: ReadonlyMap<string, CompletedWorkflowStep>;
}

const INTERPOLATE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * 简化编排引擎：顺序 / 并行 / if / switch / 多 agent 调用。
 * - 变量：{{var}} 插值；saveAs 输出注册为 <saveAs>.text
 * - 每个步骤经工厂创建独立 agent 实例执行
 * - 护栏：嵌套深度与总步骤数硬上限，防止多 agent 互相调用死循环
 */
export class Orchestrator {
  private readonly createAgent: (name: string, stepId?: string) => AgentDriver | undefined;
  private readonly events: (event: CoreMindEvent) => void;
  private readonly initialPrompt?: string;
  private readonly signal?: AbortSignal;
  private readonly maxDepth: number;
  private readonly maxSteps: number;
  private readonly stepTimeoutMs: number;
  private stepCount = 0;
  private readonly maxRetries: number;
  private retryCount = 0;
  private readonly completedSteps: ReadonlyMap<string, CompletedWorkflowStep>;

  /** outputs：saveAs → 输出（并行步骤共享） */
  readonly outputs = new Map<string, StepOutput>();
  /** 插值变量源（outputs 自动注册 + initialPrompt → prompt） */
  readonly variables = new Map<string, string>();

  constructor(
    private readonly steps: WorkflowStep[],
    opts: OrchestratorOptions,
  ) {
    this.createAgent = opts.createAgent;
    this.events = opts.events;
    this.initialPrompt = opts.initialPrompt;
    this.signal = opts.signal;
    this.maxDepth = opts.maxDepth ?? 8;
    this.maxSteps = opts.maxSteps ?? 100;
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 300_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryCount = opts.initialRetryCount ?? 0;
    this.completedSteps = opts.completedSteps ?? new Map();
    this.stepCount = this.completedSteps.size;
    if (opts.initialPrompt !== undefined) {
      this.variables.set("prompt", opts.initialPrompt);
    }
    for (const completed of this.completedSteps.values()) {
      if (completed.saveAs) this.saveOutput(completed.saveAs, completed.output);
    }
  }

  /** 执行整个 workflow，返回 outputs */
  async run(): Promise<Map<string, StepOutput>> {
    await this.runSteps(this.steps, 0);
    return this.outputs;
  }

  private async runSteps(steps: WorkflowStep[], depth: number): Promise<void> {
    for (const step of steps) {
      await this.runStep(step, depth);
    }
  }

  private async runStep(step: WorkflowStep, depth: number): Promise<StepOutput> {
    if (this.signal?.aborted) {
      throw new CoreMindError("aborted", "执行已中止");
    }
    const completed = this.completedSteps.get(step.id);
    if (completed) {
      this.events({ type: "step_resumed", stepId: step.id });
      return completed.output;
    }
    this.checkGuard(step, depth);
    this.stepCount += 1;

    switch (step.type) {
      case "prompt":
      case "call":
        return this.runAgentStep(step, depth);
      case "parallel":
        return this.runParallelStep(step, depth);
      case "if":
        return this.runIfStep(step, depth);
      case "switch":
        return this.runSwitchStep(step, depth);
    }
  }

  /**
   * 派发任务给某 agent（唯一执行 Agent 的地方；每步独立实例）。
   * 支持：单步超时护栏（stepTimeoutMs）、质量把关重试（retry.if 为真则重试）。
   */
  private async runAgentStep(
    step: Extract<WorkflowStep, { type: "prompt" | "call" }>,
    _depth: number,
  ): Promise<StepOutput> {
    const retryCfg = step.retry;
    const maxAttempts = 1 + (retryCfg?.max ?? 1);
    this.events({ type: "step_start", stepId: step.id, kind: step.type });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const agent = this.createAgent(step.agent, step.id);
      if (!agent) {
        throw new CoreMindError(
          "unknown_agent",
          `workflow 引用了未定义的 agent：${step.agent}（第 ${step.id} 步）`,
        );
      }
      try {
        const input = this.interpolate(step.input);
        const text = await this.promptWithTimeout(agent, input, step.id);
        const output: StepOutput = { text, metadata: { agent: step.agent, stepId: step.id } };

        const retryNeeded =
          retryCfg?.if !== undefined &&
          evalCondition(this.interpolateWithStepText(retryCfg.if, text));
        if (retryNeeded && attempt < maxAttempts) {
          if (this.retryCount >= this.maxRetries) {
            throw new CoreMindError(
              "retry_limit",
              `工作流重试次数达到上限（${this.maxRetries} 次），已中止：${step.id}`,
            );
          }
          this.retryCount += 1;
          this.events({
            type: "retry",
            scope: "workflow",
            attempt: this.retryCount,
            stepId: step.id,
          });
          this.events({
            type: "error",
            message: `步骤 ${step.id} 输出未通过质量检查，第 ${attempt} 次重试中`,
            fatal: false,
          });
          continue;
        }
        if (retryNeeded) {
          this.events({
            type: "error",
            message: `步骤 ${step.id} 重试 ${maxAttempts - 1} 次后仍未通过质量检查`,
            fatal: true,
          });
          throw new CoreMindError(
            "retry_exhausted",
            `步骤 ${step.id} 的已知不合格输出在重试耗尽后被拒绝`,
          );
        }
        if (step.saveAs) this.saveOutput(step.saveAs, output);
        this.events({
          type: "step_output",
          stepId: step.id,
          agent: step.agent,
          text: output.text,
          ...(step.saveAs ? { saveAs: step.saveAs } : {}),
        });
        this.events({ type: "step_end", stepId: step.id, ok: true });
        return output;
      } catch (error) {
        this.events({ type: "step_end", stepId: step.id, ok: false });
        throw error;
      }
    }
    throw new CoreMindError("step_limit", `步骤 ${step.id} 重试次数异常`);
  }

  /** 单步执行 + 超时护栏：超时中止 agent 并抛 step_timeout */
  private async promptWithTimeout(
    agent: AgentDriver,
    input: string,
    stepId: string,
  ): Promise<string> {
    const timeoutMs = this.stepTimeoutMs;
    if (timeoutMs <= 0) {
      await agent.prompt(input);
      await agent.waitForIdle();
      return extractSuccessfulText(agent, stepId);
    }
    let timer: NodeJS.Timeout | undefined;
    const run = (async () => {
      await agent.prompt(input);
      await agent.waitForIdle();
    })();
    try {
      await Promise.race([
        run,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            agent.abort();
            reject(
              new CoreMindError(
                "step_timeout",
                `步骤 ${stepId} 执行超时（${timeoutMs}ms），已中止`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return extractSuccessfulText(agent, stepId);
  }

  /** 重试条件插值：{{text}} 指本步骤输出，其余变量走正常插值 */
  private interpolateWithStepText(expr: string, text: string): string {
    return expr.replace(INTERPOLATE_RE, (_m, name: string) => {
      if (name === "text") return text;
      return this.variables.get(name) ?? _m;
    });
  }

  /** 并行执行子步骤：共享 outputs/variables，事件按声明顺序聚合文本 */
  private async runParallelStep(
    step: Extract<WorkflowStep, { type: "parallel" }>,
    depth: number,
  ): Promise<StepOutput> {
    this.events({ type: "step_start", stepId: step.id, kind: "parallel" });
    const results = await Promise.all(step.steps.map((s) => this.runStep(s, depth + 1)));
    const text = results
      .map((r) => r.text)
      .filter((t) => t.length > 0)
      .join("\n");
    const output: StepOutput = { text, metadata: { agent: "", stepId: step.id } };
    if (step.saveAs) this.saveOutput(step.saveAs, output);
    this.events({
      type: "step_output",
      stepId: step.id,
      agent: "",
      text,
      ...(step.saveAs ? { saveAs: step.saveAs } : {}),
    });
    this.events({ type: "step_end", stepId: step.id, ok: true });
    return output;
  }

  private async runIfStep(
    step: Extract<WorkflowStep, { type: "if" }>,
    depth: number,
  ): Promise<StepOutput> {
    this.events({ type: "step_start", stepId: step.id, kind: "if" });
    const branch = evalCondition(this.interpolate(step.condition)) ? step.then : step.else;
    if (branch) await this.runSteps(branch, depth + 1);
    this.events({ type: "step_output", stepId: step.id, agent: "", text: "" });
    this.events({ type: "step_end", stepId: step.id, ok: true });
    return emptyOutput(step.id);
  }

  private async runSwitchStep(
    step: Extract<WorkflowStep, { type: "switch" }>,
    depth: number,
  ): Promise<StepOutput> {
    this.events({ type: "step_start", stepId: step.id, kind: "switch" });
    const value = this.variables.get(step.on) ?? "";
    // 命中判定：变量值包含 case 键（对长文本更实用）
    const hit = Object.keys(step.cases).find((key) => value.includes(key));
    const branch = hit ? step.cases[hit] : step.default;
    if (branch) await this.runSteps(branch, depth + 1);
    this.events({ type: "step_output", stepId: step.id, agent: "", text: "" });
    this.events({ type: "step_end", stepId: step.id, ok: true });
    return emptyOutput(step.id);
  }

  private saveOutput(key: string, output: StepOutput): void {
    this.outputs.set(key, output);
    this.variables.set(`${key}.text`, output.text);
    this.variables.set(key, output.text);
  }

  /** {{var}} 插值：未命中变量原样保留 */
  private interpolate(text: string): string {
    return text.replace(INTERPOLATE_RE, (_m, name: string) => {
      return this.variables.get(name) ?? _m;
    });
  }

  private checkGuard(step: WorkflowStep, depth: number): void {
    if (depth > this.maxDepth) {
      throw new CoreMindError(
        "step_limit",
        `工作流嵌套过深（超过 ${this.maxDepth} 层），已中止：${step.id}`,
      );
    }
    if (this.stepCount >= this.maxSteps) {
      throw new CoreMindError("step_limit", `工作流步骤数超过上限（${this.maxSteps} 步），已中止`);
    }
  }
}

function emptyOutput(stepId: string): StepOutput {
  return { text: "", metadata: { agent: "", stepId } };
}

function extractSuccessfulText(agent: AgentDriver, stepId: string): string {
  const messages = agent.messages();
  const agentError = extractAgentError(messages);
  if (agentError) {
    throw new CoreMindError("agent_failed", `步骤 ${stepId} 的 Agent 执行失败：${agentError}`);
  }
  return extractText(messages);
}

/**
 * 条件求值（刻意极简，一期不做表达式解析器）：
 * - 插值后的整体：空串视为假，"true"/"false" 字面量直接判定
 * - 支持 "X == Y"、"X != Y"、"X contains Y" 字符串比较
 * - 其他非空内容视为真
 */
export function evalCondition(condition: string): boolean {
  const cond = condition.trim();
  if (cond.length === 0) return false;
  if (cond === "true") return true;
  if (cond === "false") return false;

  const containsMatch = cond.match(/^(.*?)\s+contains\s+(.*)$/);
  if (containsMatch) {
    return Boolean(containsMatch[1]?.includes(containsMatch[2] ?? ""));
  }
  const equalMatch = cond.match(/^(.*?)\s*==\s*(.*)$/);
  if (equalMatch) {
    return equalMatch[1]! === equalMatch[2]!;
  }
  const notEqualMatch = cond.match(/^(.*?)\s*!=\s*(.*)$/);
  if (notEqualMatch) {
    return notEqualMatch[1]! !== notEqualMatch[2]!;
  }
  return true;
}

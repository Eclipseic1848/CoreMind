import type { Agent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentConfig, CoreMindConfig } from "coremind-config";
import { resolveSkills, SKILLS } from "coremind-templates";
import { buildTools } from "coremind-tools";
import { buildAgent } from "./agent-factory.js";
import { CoreMindError } from "./errors.js";
import { type CoreMindEvent, extractText } from "./events.js";
import { Orchestrator, type StepOutput } from "./orchestrator.js";
import { buildProviderRuntime, type ProviderRuntime } from "./provider.js";
import { analyzeRun, type RunQuality } from "./quality.js";
import { CoreMindSession } from "./session.js";

export interface CoreMindRuntimeOptions {
  /** 已校验的配置 */
  config: CoreMindConfig;
  /** 配置文件所在目录（脚本工具相对路径、会话目录基准） */
  configDir: string;
  /** 工作目录（默认 process.cwd()） */
  cwd?: string;
  /** 环境变量（默认 process.env） */
  env?: NodeJS.ProcessEnv;
  /** 首条用户输入（注册为 {{prompt}} 变量；单 agent 模式的输入） */
  initialPrompt?: string;
  /** 事件回调（CLI 渲染 / Web 面板共用） */
  events?: (event: CoreMindEvent) => void;
  signal?: AbortSignal;
  /** 会话 id：落盘文件名标识（断点续聊恢复二期提供） */
  sessionId?: string;
  /** 工作流总步骤上限（护栏，默认 100） */
  maxSteps?: number;
  /** 单步骤超时毫秒（护栏，默认 300000 = 5 分钟；0 = 不超时） */
  stepTimeoutMs?: number;
}

export interface RunResult {
  /** workflow 步骤输出（saveAs → 输出） */
  outputs: Map<string, StepOutput>;
  /** agent 名 → 最终消息 */
  messages: Map<string, AgentMessage[]>;
  /** 主输出文本（CLI --print 直接打印） */
  transcript: string;
  /** 会话文件路径（已落盘时） */
  sessionFile?: string;
  /** 质量摘要（步骤/工具/耗时/token）——跑完知道好不好 */
  quality: RunQuality;
}

/**
 * CoreMind 运行时门面：配置 → provider/工具/agent → 执行。
 * 库形式嵌入入口：buildAgentFromConfig / CoreMindRuntime.create().run()
 */
export class CoreMindRuntime {
  /** 最近创建的每个 agent 实例（收集最终消息/落盘用） */
  private readonly lastAgents = new Map<string, Agent>();
  /** 恢复的会话上下文消息数（0 = 未恢复） */
  readonly resumedContextLength: number;
  /** 主 agent 名（会话归属） */
  private readonly mainAgentName: string;
  /** 恢复视图（作为主 agent 初始消息） */
  private readonly sessionMessages?: AgentMessage[];
  /** agent 名 → 注入的技能内容 */
  private readonly skillsByAgent: Map<string, string[]>;

  private constructor(
    private readonly config: CoreMindConfig,
    private readonly agentConfigs: Map<string, AgentConfig>,
    private readonly toolsByAgent: Map<string, AgentTool[]>,
    private readonly providerRuntime: ProviderRuntime,
    private readonly options: CoreMindRuntimeOptions,
    sessionMessages: AgentMessage[] | undefined,
    resumedContextLength: number,
    skillsByAgent: Map<string, string[]>,
  ) {
    this.sessionMessages = sessionMessages;
    this.resumedContextLength = resumedContextLength;
    this.mainAgentName = config.defaultAgent ?? firstKey(config.agents) ?? "";
    this.skillsByAgent = skillsByAgent;
  }

  /** 由配置构建运行时（注册 provider、构建工具与全部 agent 定义） */
  static async create(options: CoreMindRuntimeOptions): Promise<CoreMindRuntime> {
    const { config, configDir } = options;
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const emit = options.events ?? (() => {});

    // 1. provider（解析模型，警告转发）
    const providerRuntime = await buildProviderRuntime(config.provider, env);
    for (const warning of providerRuntime.warnings) {
      emit({ type: "error", message: warning, fatal: false });
    }

    // 2. 每个 agent：构建工具与技能（Agent 实例按需创建，避免并发冲突）
    const agentConfigs = new Map<string, AgentConfig>();
    const toolsByAgent = new Map<string, AgentTool[]>();
    const skillsByAgent = new Map<string, string[]>();
    for (const [name, agentCfg] of Object.entries(config.agents)) {
      const toolConfigs = (agentCfg.tools?.length ?? 0) > 0 ? agentCfg.tools : config.tools;
      const { tools, warnings } = await buildTools(toolConfigs ?? [], { cwd, configDir, env });
      for (const warning of warnings) {
        emit({ type: "error", message: warning, fatal: false });
      }
      agentConfigs.set(name, agentCfg);
      toolsByAgent.set(name, tools);

      // 技能：解析注入内容，未命中 id 告警（不阻断）
      const { contents, missing } = resolveSkills(agentCfg.skills ?? []);
      for (const id of missing) {
        emit({
          type: "error",
          message: `技能 ${id} 不存在，已忽略（可用：${SKILLS.map((s) => s.id).join("、")}）`,
          fatal: false,
        });
      }
      skillsByAgent.set(name, contents);
    }

    // 会话恢复：--session 且 session.enabled 时，打开已有会话注入历史视图（非破坏）
    let sessionMessages: AgentMessage[] | undefined;
    let resumedContextLength = 0;
    if (options.sessionId && config.session?.enabled) {
      const dir = sessionDir(config, configDir);
      try {
        if (await CoreMindSession.exists(dir, options.sessionId, cwd)) {
          const cm = await CoreMindSession.open({ dir, sessionId: options.sessionId, cwd });
          const ctx = await cm.buildContext();
          if (ctx.messages.length > 0) {
            sessionMessages = ctx.messages;
            resumedContextLength = ctx.messages.length;
          }
        }
      } catch {
        // 会话损坏时降级为新会话（不阻断运行）
      }
    }
    return new CoreMindRuntime(
      config,
      agentConfigs,
      toolsByAgent,
      providerRuntime,
      options,
      sessionMessages,
      resumedContextLength,
      skillsByAgent,
    );
  }

  /** 按名字创建独立 Agent 实例（每次新实例，消息历史独立） */
  createAgent(name: string): Agent | undefined {
    const agentCfg = this.agentConfigs.get(name);
    if (!agentCfg) return undefined;
    const agent = buildAgent(agentCfg, {
      models: this.providerRuntime.models,
      model: this.providerRuntime.model,
      tools: this.toolsByAgent.get(name) ?? [],
      agentName: name,
      onEvent: this.options.events ?? (() => {}),
      apiKeyOverride: this.providerRuntime.apiKeyOverride,
      // 恢复视图只注入主 agent（会话归属者）
      sessionMessages: name === this.mainAgentName ? this.sessionMessages : undefined,
      skillsContent: this.skillsByAgent.get(name),
    });
    this.lastAgents.set(name, agent);
    return agent;
  }

  /** 执行：有 workflow 走编排，否则单 agent 直答。返回结果含质量摘要 */
  async run(): Promise<RunResult> {
    const started = performance.now();
    const collected: CoreMindEvent[] = [];
    const userEvents = this.options.events ?? (() => {});
    const emit = (event: CoreMindEvent) => {
      collected.push(event);
      userEvents(event);
    };
    const workflow = this.config.workflow;

    let outputs: Map<string, StepOutput>;
    let transcript: string;
    if (workflow && workflow.length > 0) {
      const orchestrator = new Orchestrator(workflow, {
        createAgent: (name) => this.createAgent(name),
        events: emit,
        initialPrompt: this.options.initialPrompt,
        signal: this.options.signal,
        maxSteps: this.options.maxSteps,
        stepTimeoutMs: this.options.stepTimeoutMs,
      });
      outputs = await orchestrator.run();
      transcript = lastOutputText(outputs);
    } else {
      // 单 agent 模式
      const name = this.config.defaultAgent ?? firstKey(this.config.agents);
      if (!name) {
        throw new CoreMindError("no_agent", "配置中没有定义任何 agent，请至少定义一个 agents 条目");
      }
      if (this.options.initialPrompt === undefined) {
        throw new CoreMindError(
          "no_prompt",
          "未提供输入：单 agent 模式需要 --prompt 参数，或配置 workflow 步骤",
        );
      }
      const agent = this.createAgent(name);
      if (!agent) {
        throw new CoreMindError("unknown_agent", `默认 agent ${name} 不存在`);
      }
      await agent.prompt(this.options.initialPrompt);
      await agent.waitForIdle();
      transcript = extractText(agent.state.messages);
      outputs = new Map();
    }

    const sessionFile = await this.persistSession();
    const allMessages = [...this.collectMessages().values()].flat();
    const quality = analyzeRun(
      collected,
      allMessages,
      performance.now() - started,
      transcript.length,
    );
    return { outputs, messages: this.collectMessages(), transcript, sessionFile, quality };
  }

  private collectMessages(): Map<string, AgentMessage[]> {
    const messages = new Map<string, AgentMessage[]>();
    for (const [name, agent] of this.lastAgents) messages.set(name, agent.state.messages);
    return messages;
  }

  /** 会话配置开启时，把主 agent 本轮新增消息追加落盘（返回会话文件路径） */
  async persistSession(): Promise<string | undefined> {
    const sessionId = this.options.sessionId;
    const session = this.config.session;
    if (!sessionId || !session?.enabled) return undefined;
    const main = this.lastAgents.get(this.mainAgentName);
    if (!main) return undefined;
    const cm = await CoreMindSession.open({
      dir: sessionDir(this.config, this.options.configDir),
      sessionId,
      cwd: this.options.cwd ?? process.cwd(),
    });
    // 只追加本轮新增（恢复时注入的历史已在会话文件中，避免重复）
    await cm.appendMessages(main.state.messages.slice(this.resumedContextLength));
    // P2b：配置 session.compact 时，上下文超预算自动压缩（LLM 摘要，消耗 token）
    if (session.compact) {
      await cm.maybeCompact(
        this.providerRuntime.models,
        this.providerRuntime.model,
        this.providerRuntime.model.contextWindow,
      );
    }
    return cm.filePath;
  }
}

/** 便捷入口：加载配置 → 构建运行时 */
export async function buildAgentFromConfig(
  options: CoreMindRuntimeOptions,
): Promise<CoreMindRuntime> {
  return CoreMindRuntime.create(options);
}

function sessionDir(config: CoreMindConfig, configDir: string): string {
  return config.session?.dir ?? configDir;
}

function lastOutputText(outputs: Map<string, StepOutput>): string {
  const values = [...outputs.values()];
  const last = values[values.length - 1];
  return last ? last.text : "";
}

function firstKey(record: Record<string, unknown>): string | undefined {
  return Object.keys(record)[0];
}

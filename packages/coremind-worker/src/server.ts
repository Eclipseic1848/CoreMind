import path from "node:path";
import {
  type CheckpointRecord,
  type CoreMindConfig,
  CoreMindError,
  CoreMindRuntime,
  type CoreMindRuntimeOptions,
  type CoreMindToolDefinition,
  FileRunStore,
  inspectCheckpoint,
  loadConfigFile,
  parseAndValidate,
  type RunResult,
  restoreCheckpoint,
} from "coremind-ai";
import { ProjectionEngine } from "coremind-ai/internal";
import {
  createErrorResponse,
  createEventNotification,
  createPythonToolCallNotification,
  createSuccessResponse,
  PROTOCOL_VERSION,
  type ProtocolErrorResponse,
  type ProtocolRequest,
  type ProtocolSuccessResponse,
  ProtocolValidationError,
  parseProtocolRequest,
  parseRunSnapshot,
} from "coremind-protocol";

export type WorkerMessage =
  | ProtocolSuccessResponse
  | ProtocolErrorResponse
  | ReturnType<typeof createEventNotification>
  | ReturnType<typeof createPythonToolCallNotification>;

export type WorkerRuntime = Pick<CoreMindRuntime, "run">;
export type WorkerRuntimeFactory = (options: CoreMindRuntimeOptions) => Promise<WorkerRuntime>;

export interface WorkerServerOptions {
  send: (message: WorkerMessage) => void;
  runtimeFactory?: WorkerRuntimeFactory;
}

interface InitializedState {
  config: CoreMindConfig;
  configDir: string;
  cwd: string;
  sessionId?: string;
  runStore: FileRunStore;
}

interface PendingApproval {
  runId: string;
  resolve: (decision: "allow" | "deny") => void;
}

interface PendingToolCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/** 常驻 Node worker 的协议状态机；stdio 只是它的传输适配器。 */
export class WorkerServer {
  private readonly runtimeFactory: WorkerRuntimeFactory;
  private initialized?: InitializedState;
  private readonly toolSpecs = new Map<
    string,
    {
      name: string;
      label?: string;
      description: string;
      parameters: unknown;
      effect: CoreMindToolDefinition["effect"];
    }
  >();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private activeController?: AbortController;
  private activeRunId?: string;
  /** 请求预生成的 runId（D-1）：首事件前 cancel 的可寻址值 */
  private requestedRunId?: string;
  private running = false;
  private closed = false;

  constructor(private readonly options: WorkerServerOptions) {
    this.runtimeFactory = options.runtimeFactory ?? CoreMindRuntime.create;
  }

  /** 供 stdio 使用：不等待长运行，以便继续接收 approve/cancel/tool_result。 */
  accept(value: unknown): void {
    void this.handle(value).then((response) => this.options.send(response));
  }

  async handle(value: unknown): Promise<ProtocolSuccessResponse | ProtocolErrorResponse> {
    let request: ProtocolRequest;
    try {
      request = parseProtocolRequest(value);
    } catch (error) {
      const id = rpcIdFrom(value);
      return createErrorResponse(
        id,
        -32_600,
        error instanceof Error ? error.message : String(error),
        "protocol_validation_failed",
      );
    }

    try {
      const result = await this.dispatch(request);
      return createSuccessResponse(request.id, result);
    } catch (error) {
      return protocolError(request.id, error);
    }
  }

  private async dispatch(request: ProtocolRequest): Promise<unknown> {
    if (this.closed && request.method !== "close") {
      throw new CoreMindError("worker_closed", "CoreMind worker 已关闭");
    }
    switch (request.method) {
      case "initialize":
        return this.initialize(request.params);
      case "register_tool":
        return this.registerTool(request.params);
      case "run":
        return this.executeRun(
          request.params.input,
          undefined,
          false,
          undefined,
          request.params.runId,
        );
      case "chat":
        return this.executeRun(
          request.params.message,
          request.params.agent,
          true,
          undefined,
          request.params.runId,
        );
      case "approve":
        return this.resolveApproval(request.params);
      case "tool_result":
        return this.resolveToolCall(request.params);
      case "inspect_run":
        return this.inspectRun(request.params.runId);
      case "resume_run":
        return this.executeRun(request.params.input, undefined, false, request.params.runId);
      case "checkpoint_diff":
        return this.checkpointDiff(request.params.runId, request.params.checkpointId);
      case "checkpoint_restore":
        return this.checkpointRestore(request.params.runId, request.params.checkpointId);
      case "cancel":
        return this.cancel(request.params.runId);
      case "close":
        return this.close();
    }
  }

  private async initialize(
    params: Extract<ProtocolRequest, { method: "initialize" }>["params"],
  ): Promise<unknown> {
    if (this.initialized) throw new CoreMindError("already_initialized", "worker 已初始化");
    let rawConfig: unknown;
    let configDir: string;
    if (params.configPath) {
      const configPath = path.resolve(params.configPath);
      rawConfig = await loadConfigFile(configPath);
      configDir = params.configDir ? path.resolve(params.configDir) : path.dirname(configPath);
    } else {
      rawConfig = params.config;
      configDir = path.resolve(params.configDir ?? process.cwd());
    }
    const { config, warnings } = parseAndValidate(rawConfig);
    this.initialized = {
      config,
      configDir,
      cwd: path.resolve(params.cwd ?? configDir),
      sessionId: params.sessionId,
      runStore: new FileRunStore(path.join(configDir, ".coremind", "runs")),
    };
    return {
      protocolVersion: PROTOCOL_VERSION,
      runtime: "node",
      warnings,
      capabilities: [
        "run",
        "chat",
        "events",
        "approval",
        "cancel",
        "pythonTools",
        "runState",
        "checkpoint",
        "inspectRun",
        "resumeRun",
        "checkpointDiff",
        "checkpointRestore",
        "loop",
        "runSnapshot",
      ],
    };
  }

  private registerTool(
    params: Extract<ProtocolRequest, { method: "register_tool" }>["params"],
  ): unknown {
    this.requireInitialized();
    if (this.running) throw new CoreMindError("worker_busy", "运行期间不能注册工具");
    if (
      params.parameters === null ||
      typeof params.parameters !== "object" ||
      (params.parameters as { type?: unknown }).type !== "object"
    ) {
      throw new CoreMindError(
        "invalid_tool",
        `工具 ${params.name} 的 parameters.type 必须为 object`,
      );
    }
    if (this.toolSpecs.has(params.name)) {
      throw new CoreMindError("duplicate_tool", `工具 ${params.name} 已注册`);
    }
    this.toolSpecs.set(params.name, params);
    return { registered: params.name };
  }

  private async executeRun(
    input: string | undefined,
    agent?: string,
    persistentChat = false,
    resumeRunId?: string,
    requestedRunId?: string,
  ): Promise<unknown> {
    const state = this.requireInitialized();
    if (this.running) throw new CoreMindError("worker_busy", "同一 worker 同时只允许一个运行");
    this.running = true;
    this.activeController = new AbortController();
    this.activeRunId = undefined;
    // 预生成 runId（D-1）：首事件前 cancel 用该值寻址；未提供时保持 0.3.0 行为
    this.requestedRunId = requestedRunId;
    try {
      const baseConfig = agent
        ? { ...state.config, defaultAgent: agent, workflow: undefined }
        : state.config;
      const config = persistentChat
        ? {
            ...baseConfig,
            session: {
              enabled: true,
              dir: baseConfig.session?.dir ?? path.join(state.configDir, ".coremind", "sessions"),
              compact: baseConfig.session?.compact ?? false,
            },
          }
        : baseConfig;
      const runtime = await this.runtimeFactory({
        config,
        configDir: state.configDir,
        cwd: state.cwd,
        sessionId: persistentChat ? (state.sessionId ?? "python-default") : state.sessionId,
        initialPrompt: input,
        signal: this.activeController.signal,
        runStore: state.runStore,
        resumeRunId,
        runId: requestedRunId,
        toolDefinitions: this.createPythonToolDefinitions(),
        approveTool: (request) =>
          new Promise((resolve) => {
            this.pendingApprovals.set(request.approvalId, { runId: request.runId, resolve });
          }),
        trace: (entry) => {
          this.activeRunId = entry.runId;
          this.options.send(
            createEventNotification({
              runId: entry.runId,
              sequence: entry.sequence,
              timestamp: entry.timestamp,
              event: { eventId: entry.eventId, ...entry.event },
            }),
          );
        },
      });
      return serializeRunResult(await runtime.run());
    } finally {
      this.running = false;
      this.activeController = undefined;
      this.activeRunId = undefined;
      this.requestedRunId = undefined;
      for (const approval of this.pendingApprovals.values()) approval.resolve("deny");
      this.pendingApprovals.clear();
    }
  }

  private createPythonToolDefinitions(): CoreMindToolDefinition[] {
    return [...this.toolSpecs.values()].map((spec) => ({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters as CoreMindToolDefinition["parameters"],
      effect: spec.effect,
      execute: (args, context) => this.invokePythonTool(spec.name, context.callId, args),
    }));
  }

  private invokePythonTool(tool: string, callId: string, args: unknown): Promise<unknown> {
    const runId = this.activeRunId;
    if (!runId) {
      throw new CoreMindError("run_state_failed", "Python 工具调用前尚未建立 runId");
    }
    if (this.pendingToolCalls.has(callId)) {
      throw new CoreMindError("duplicate_tool_call", `重复的 Python 工具 callId：${callId}`);
    }
    this.options.send(createPythonToolCallNotification({ runId, callId, tool, args }));
    return new Promise((resolve, reject) => {
      this.pendingToolCalls.set(callId, { resolve, reject });
    });
  }

  private resolveToolCall(
    params: Extract<ProtocolRequest, { method: "tool_result" }>["params"],
  ): unknown {
    const pending = this.pendingToolCalls.get(params.callId);
    if (!pending) throw new CoreMindError("unknown_tool_call", `未知工具调用：${params.callId}`);
    this.pendingToolCalls.delete(params.callId);
    if (params.error !== undefined) {
      pending.reject(new CoreMindError("python_tool_failed", params.error));
    } else {
      pending.resolve(params.result);
    }
    return { accepted: true };
  }

  private resolveApproval(
    params: Extract<ProtocolRequest, { method: "approve" }>["params"],
  ): unknown {
    const pending = this.pendingApprovals.get(params.approvalId);
    if (!pending || pending.runId !== params.runId) {
      throw new CoreMindError("unknown_approval", `未知审批：${params.approvalId}`);
    }
    this.pendingApprovals.delete(params.approvalId);
    pending.resolve(params.decision);
    return { accepted: true };
  }

  private async inspectRun(runId: string): Promise<unknown> {
    const state = this.requireInitialized();
    const records = await state.runStore.read(runId);
    if (records.length === 0) throw new CoreMindError("unknown_run", `未找到 runId：${runId}`);
    return ProjectionEngine.project(records);
  }

  private async checkpointDiff(runId: string, checkpointId: string): Promise<unknown> {
    const state = this.requireInitialized();
    const record = await this.findCheckpoint(state.runStore, runId, checkpointId);
    return inspectCheckpoint(record, state.cwd);
  }

  private async checkpointRestore(runId: string, checkpointId: string): Promise<unknown> {
    if (this.running) throw new CoreMindError("worker_busy", "运行期间不能恢复 checkpoint");
    const state = this.requireInitialized();
    const record = await this.findCheckpoint(state.runStore, runId, checkpointId);
    await restoreCheckpoint(record, state.cwd);
    return { restored: true, runId, checkpointId };
  }

  private async findCheckpoint(
    store: FileRunStore,
    runId: string,
    checkpointId: string,
  ): Promise<CheckpointRecord> {
    const records = await store.read(runId);
    const checkpoint = ProjectionEngine.project(records).checkpoints.find(
      (record) => record.checkpointId === checkpointId,
    );
    if (!checkpoint) {
      throw new CoreMindError(
        "checkpoint_not_found",
        `运行 ${runId} 没有 checkpoint：${checkpointId}`,
      );
    }
    return checkpoint;
  }

  private cancel(runId: string): unknown {
    // 首事件前：用请求预生成的 runId 寻址（D-1）；首事件后：用 activeRunId
    const current = this.activeRunId ?? this.requestedRunId;
    if (!this.running || current !== runId || !this.activeController) {
      throw new CoreMindError("unknown_run", `当前没有运行中的 runId：${runId}`);
    }
    this.activeController.abort();
    return { cancelled: true };
  }

  private close(): unknown {
    this.activeController?.abort();
    for (const approval of this.pendingApprovals.values()) approval.resolve("deny");
    for (const pending of this.pendingToolCalls.values()) {
      pending.reject(new CoreMindError("worker_closed", "worker 已关闭"));
    }
    this.pendingApprovals.clear();
    this.pendingToolCalls.clear();
    this.closed = true;
    return { closed: true };
  }

  private requireInitialized(): InitializedState {
    if (!this.initialized) throw new CoreMindError("not_initialized", "请先调用 initialize");
    return this.initialized;
  }
}

function serializeRunResult(result: RunResult): unknown {
  return {
    ...result,
    snapshot: parseRunSnapshot(result.snapshot),
    outputs: Object.fromEntries(result.outputs),
    messages: Object.fromEntries(result.messages),
  };
}

function rpcIdFrom(value: unknown): string | number {
  if (value !== null && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return "invalid";
}

function protocolError(id: string | number, error: unknown): ProtocolErrorResponse {
  if (error instanceof CoreMindError) {
    return createErrorResponse(id, -32_000, error.message, error.code);
  }
  if (error instanceof ProtocolValidationError) {
    return createErrorResponse(id, -32_600, error.message, "protocol_validation_failed");
  }
  return createErrorResponse(
    id,
    -32_603,
    error instanceof Error ? error.message : String(error),
    "internal_error",
  );
}

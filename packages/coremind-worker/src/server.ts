import { createHash } from "node:crypto";
import path from "node:path";
import {
  type CheckpointRecord,
  type ControlApplyResult,
  type ControlReceipt,
  type CoreMindConfig,
  CoreMindError,
  CoreMindRuntime,
  type CoreMindRuntimeOptions,
  type CoreMindToolDefinition,
  FileRunStore,
  inspectCheckpoint,
  loadConfigFile,
  type ProtocolStartIdentity,
  parseAndValidate,
  type RunControlCommand,
  type RunResult,
  RunStateJournal,
  type RunStateRecord,
  restoreCheckpoint,
} from "coremind-ai";
import { classifyExecutionError, ProjectionEngine } from "coremind-ai/internal";
import {
  createErrorResponse,
  createEventNotification,
  createPythonToolCallNotification,
  createSuccessResponse,
  negotiateProtocolV2,
  PROTOCOL_V2_SCHEMA_FINGERPRINT,
  PROTOCOL_VERSION,
  type ProtocolErrorResponse,
  type ProtocolRequest,
  type ProtocolSuccessResponse,
  type ProtocolV2ControlRequest,
  type ProtocolV2EventsRequest,
  type ProtocolV2InitializeRequest,
  ProtocolV2NegotiationError,
  type ProtocolV2QueryRequest,
  type ProtocolV2Request,
  type ProtocolV2RunHandle,
  type ProtocolV2StartRequest,
  ProtocolV2ValidationError,
  ProtocolValidationError,
  parseProtocolRequest,
  parseProtocolV2Request,
  parseRunSnapshot,
} from "coremind-protocol";

const PROTOCOL_V2_SERVER_CAPABILITIES = [
  "runHandle",
  "typedEvents",
  "cursorResume",
  "controlInbox",
  "projectionQuery",
] as const;
const PROTOCOL_V2_AVAILABLE_CONTROLS = ["cancel", "approval", "steering", "follow_up"] as const;

export type WorkerMessage =
  | ProtocolSuccessResponse
  | ProtocolErrorResponse
  | ReturnType<typeof createEventNotification>
  | ReturnType<typeof createPythonToolCallNotification>;

export type WorkerRuntime = Pick<CoreMindRuntime, "run"> & {
  acceptControl?: (command: RunControlCommand) => Promise<ControlReceipt>;
  applyPendingControls?: () => Promise<ControlReceipt[]>;
};
export type WorkerRuntimeFactory = (options: CoreMindRuntimeOptions) => Promise<WorkerRuntime>;

export interface WorkerServerOptions {
  send: (message: WorkerMessage) => void;
  runtimeFactory?: WorkerRuntimeFactory;
  runStoreFactory?: (directory: string) => ProtocolEventRunStore;
}

export interface ProtocolEventWindow {
  retainedFromSequence: number;
  latestSequence: number;
  records: RunStateRecord[];
}

export type ProtocolEventRunStore = FileRunStore & {
  readEventWindow?: (options: {
    runId: string;
    afterSequence: number;
    limit: number;
  }) => Promise<ProtocolEventWindow>;
};

interface InitializedState {
  config: CoreMindConfig;
  configDir: string;
  cwd: string;
  sessionId?: string;
  runStore: ProtocolEventRunStore;
}

interface PendingApproval {
  runId: string;
  resolve: (decision: "allow" | "deny") => void;
}

interface PendingToolCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/** 常驻 Node Protocol Host；stdio 只是它的传输适配器。 */
export class ProtocolHost {
  private readonly runtimeFactory: WorkerRuntimeFactory;
  private initialized?: InitializedState;
  private selectedProtocol?: typeof PROTOCOL_VERSION | "2.0";
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
  private readonly protocolV2Starts = new Map<
    string,
    {
      method: ProtocolV2StartRequest["method"];
      fingerprint: string;
      handle: ProtocolV2RunHandle;
    }
  >();
  private activeController?: AbortController;
  private activeRuntime?: WorkerRuntime;
  private activeRunId?: string;
  /** 请求预生成的 runId（D-1）：首事件前 cancel 的可寻址值 */
  private requestedRunId?: string;
  private running = false;
  private closed = false;
  private activeExecutionCompletion?: Promise<void>;
  private resolveActiveExecution?: () => void;
  private lastExecutionQuiescent = true;

  constructor(private readonly options: WorkerServerOptions) {
    this.runtimeFactory = options.runtimeFactory ?? CoreMindRuntime.create;
  }

  /** 传输断开只影响交付，不得反向污染 Runtime 或权威 Fact。 */
  private send(message: WorkerMessage): void {
    try {
      this.options.send(message);
    } catch {
      return;
    }
  }

  /** 供 stdio 使用：不等待长运行，以便继续接收 approve/cancel/tool_result。 */
  accept(value: unknown): void {
    void this.handle(value).then((response) => this.send(response));
  }

  async handle(value: unknown): Promise<ProtocolSuccessResponse | ProtocolErrorResponse> {
    if (isProtocolV2Initialize(value)) return this.handleProtocolV2Initialize(value);
    if (this.selectedProtocol === "2.0") {
      return isProtocolV2Envelope(value)
        ? this.handleProtocolV2(value)
        : createErrorResponse(
            rpcIdFrom(value),
            -32_601,
            "v2 连接不能混用 v1 request envelope",
            "protocol_version_mixed",
          );
    }
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
      if (request.method === "initialize") this.selectedProtocol = PROTOCOL_VERSION;
      return createSuccessResponse(request.id, result);
    } catch (error) {
      return protocolError(request.id, error);
    }
  }

  private async handleProtocolV2(
    value: unknown,
  ): Promise<ProtocolSuccessResponse | ProtocolErrorResponse> {
    let request: ProtocolV2Request;
    try {
      request = parseProtocolV2Request(value);
    } catch (error) {
      return protocolError(rpcIdFrom(value), error);
    }
    try {
      if (request.method === "run" || request.method === "chat" || request.method === "resume") {
        return createSuccessResponse(request.id, await this.beginProtocolV2Run(request));
      }
      if (request.method === "control") {
        return createSuccessResponse(request.id, await this.acceptProtocolV2Control(request));
      }
      if (request.method === "events") {
        return createSuccessResponse(request.id, await this.readProtocolV2Events(request));
      }
      if (request.method === "query") {
        return createSuccessResponse(request.id, await this.queryProtocolV2Projection(request));
      }
      return createErrorResponse(
        request.id,
        -32_601,
        "v2 连接已经完成 initialize",
        "protocol_version_mixed",
      );
    } catch (error) {
      return protocolError(request.id, error);
    }
  }

  private async beginProtocolV2Run(request: ProtocolV2StartRequest): Promise<ProtocolV2RunHandle> {
    const fingerprint = protocolV2StartFingerprint(request);
    const existing = this.protocolV2Starts.get(request.params.runId);
    if (existing) {
      if (existing.fingerprint === fingerprint) return existing.handle;
      if (request.method !== "resume" || existing.method === "resume") {
        throw new CoreMindError(
          "run_id_conflict",
          `runId ${request.params.runId} 已绑定不同的 start 请求`,
        );
      }
    }
    const state = this.requireInitialized();
    const records = await state.runStore.read(request.params.runId);
    const persisted = persistedProtocolV2Start(records);
    if (persisted) {
      if (persisted.fingerprint === fingerprint) {
        if (ProjectionEngine.project(records).status === "interrupted") {
          const journal = new RunStateJournal(
            request.params.runId,
            state.runStore,
            records.at(-1)!.sequence,
          );
          journal.pause({ reason: "process_interrupted" });
          await journal.flush();
        }
        const handle = protocolV2RunHandle(request.params.runId, persisted.acceptedAt);
        this.protocolV2Starts.set(request.params.runId, {
          method: request.method,
          fingerprint,
          handle,
        });
        return handle;
      }
      // 第一次 resume 合法地承接既有 run/chat；重复 resume 则仍由指纹约束。
      if (request.method !== "resume" || persisted.method === "resume") {
        throw new CoreMindError(
          "run_id_conflict",
          `runId ${request.params.runId} 已绑定不同的 start 请求`,
        );
      }
    } else if (records.length > 0 && request.method !== "resume") {
      throw new CoreMindError(
        "run_id_conflict",
        `runId ${request.params.runId} 已存在但缺少可验证的 v2 start 身份`,
      );
    }
    if (this.running) throw new CoreMindError("worker_busy", "同一 worker 同时只允许一个运行");
    const handle = protocolV2RunHandle(request.params.runId, new Date().toISOString());
    const protocolStart: ProtocolStartIdentity = {
      protocolVersion: "2.0",
      method: request.method,
      fingerprint,
      acceptedAt: handle.acceptedAt,
    };
    this.protocolV2Starts.set(request.params.runId, {
      method: request.method,
      fingerprint,
      handle,
    });
    const completion =
      request.method === "chat"
        ? this.executeRun(
            request.params.message,
            request.params.agent,
            true,
            undefined,
            request.params.runId,
            protocolStart,
          )
        : this.executeRun(
            request.params.input,
            undefined,
            false,
            request.method === "resume" ? request.params.runId : undefined,
            request.params.runId,
            protocolStart,
          );
    void completion.catch(() => undefined);
    return handle;
  }

  private async acceptProtocolV2Control(
    request: ProtocolV2ControlRequest,
  ): Promise<ControlReceipt> {
    const runtime = await this.waitForActiveRuntime(request.params.runId);
    if (!runtime.acceptControl) {
      throw new CoreMindError("control_unavailable", "当前 Runtime 不支持持久 ControlInbox");
    }
    return runtime.acceptControl(request.params);
  }

  private async readProtocolV2Events(request: ProtocolV2EventsRequest): Promise<unknown> {
    const state = this.requireInitialized();
    const records = await state.runStore.read(request.params.runId);
    if (records.length === 0) {
      throw new CoreMindError("unknown_run", `未找到 runId：${request.params.runId}`);
    }
    const projection = ProjectionEngine.project(records);
    const latestSequence = records.at(-1)!.sequence;
    if (request.params.afterSequence > latestSequence) {
      throw new CoreMindError(
        "cursor_ahead",
        `afterSequence ${request.params.afterSequence} 超过当前最新 sequence ${latestSequence}`,
      );
    }
    const limit = request.params.limit ?? 100;
    const window = state.runStore.readEventWindow
      ? await state.runStore.readEventWindow({
          runId: request.params.runId,
          afterSequence: request.params.afterSequence,
          limit,
        })
      : {
          retainedFromSequence: records[0]!.sequence,
          latestSequence,
          records: records
            .filter((record) => record.sequence > request.params.afterSequence)
            .slice(0, limit),
        };
    validateProtocolEventWindow(window, latestSequence);
    if (request.params.afterSequence < window.retainedFromSequence - 1) {
      throw new ProtocolCursorExpiredError({
        runId: request.params.runId,
        newCursor: window.retainedFromSequence - 1,
        derivedFromSequence: latestSequence,
        projection,
      });
    }
    const page = window.records
      .filter((record) => record.sequence > request.params.afterSequence)
      .slice(0, limit);
    const nextCursor = page.at(-1)?.sequence ?? request.params.afterSequence;
    return {
      schemaVersion: 1,
      runId: request.params.runId,
      afterSequence: request.params.afterSequence,
      nextCursor,
      hasMore: nextCursor < window.latestSequence,
      events: page.map(toProtocolV2Event),
    };
  }

  private async queryProtocolV2Projection(request: ProtocolV2QueryRequest): Promise<unknown> {
    const state = this.requireInitialized();
    const records = await state.runStore.read(request.params.runId);
    if (records.length === 0) {
      throw new CoreMindError("unknown_run", `未找到 runId：${request.params.runId}`);
    }
    return {
      schemaVersion: 1,
      runId: request.params.runId,
      derivedFromSequence: records.at(-1)!.sequence,
      projection: await ProjectionEngine.projectTree(state.runStore, request.params.runId),
    };
  }

  private async waitForActiveRuntime(runId: string): Promise<WorkerRuntime> {
    for (let attempt = 0; attempt < 5_000; attempt++) {
      const currentRunId = this.activeRunId ?? this.requestedRunId;
      if (!this.running || currentRunId !== runId) {
        throw new CoreMindError("unknown_run", `当前没有运行中的 runId：${runId}`);
      }
      if (this.activeRuntime) return this.activeRuntime;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new CoreMindError("control_unavailable", `等待 Runtime ${runId} 的 ControlInbox 超时`);
  }

  private async handleProtocolV2Initialize(
    value: unknown,
  ): Promise<ProtocolSuccessResponse | ProtocolErrorResponse> {
    let request: ProtocolV2InitializeRequest;
    try {
      const parsed = parseProtocolV2Request(value);
      if (parsed.method !== "initialize") {
        throw new ProtocolV2ValidationError("v2 initialize 路径收到非 initialize 请求");
      }
      request = parsed;
    } catch (error) {
      return protocolError(rpcIdFrom(value), error);
    }
    try {
      const selectedProtocol = negotiateProtocolV2(request.params.protocolRange);
      const initialized = (await this.initialize(toV1InitializeParams(request.params))) as {
        warnings: string[];
      };
      this.selectedProtocol = selectedProtocol;
      return createSuccessResponse(request.id, {
        selectedProtocol,
        runtime: "node",
        warnings: initialized.warnings,
        serverCapabilities: [...PROTOCOL_V2_SERVER_CAPABILITIES],
        schemaFingerprint: PROTOCOL_V2_SCHEMA_FINGERPRINT,
        migration: {
          v1Supported: true,
          v1SupportedThrough: "0.4.x",
          earliestRemoval: "0.5.0",
        },
      });
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
      runStore:
        this.options.runStoreFactory?.(path.join(configDir, ".coremind", "runs")) ??
        new FileRunStore(path.join(configDir, ".coremind", "runs")),
    };
    return {
      protocolVersion: PROTOCOL_VERSION,
      runtime: "node",
      warnings,
      migration: {
        recommendedProtocol: "2.0",
        v1SupportedThrough: "0.4.x",
        earliestRemoval: "0.5.0",
      },
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
        "localObservability",
        "telemetryProjection",
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
    protocolStart?: ProtocolStartIdentity,
  ): Promise<unknown> {
    const state = this.requireInitialized();
    if (this.running) throw new CoreMindError("worker_busy", "同一 worker 同时只允许一个运行");
    this.running = true;
    this.lastExecutionQuiescent = false;
    this.activeExecutionCompletion = new Promise<void>((resolve) => {
      this.resolveActiveExecution = resolve;
    });
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
        protocolStart,
        toolDefinitions: this.createPythonToolDefinitions(),
        approveTool: async (request) => {
          const decision = new Promise<"allow" | "deny">((resolve) => {
            this.pendingApprovals.set(request.approvalId, { runId: request.runId, resolve });
          });
          await this.activeRuntime?.applyPendingControls?.();
          return decision;
        },
        trace: (entry) => {
          this.activeRunId = entry.runId;
          this.send(
            createEventNotification({
              runId: entry.runId,
              sequence: entry.sequence,
              timestamp: entry.timestamp,
              event: { eventId: entry.eventId, ...entry.event },
            }),
          );
        },
        applyControl: (command) => this.applyWorkerControl(command),
      });
      this.activeRuntime = runtime;
      const result = await runtime.run();
      this.lastExecutionQuiescent = result.childRuns?.quiescent !== false;
      return serializeRunResult(result);
    } finally {
      this.running = false;
      this.activeController = undefined;
      this.activeRuntime = undefined;
      this.activeRunId = undefined;
      this.requestedRunId = undefined;
      for (const approval of this.pendingApprovals.values()) approval.resolve("deny");
      this.pendingApprovals.clear();
      this.resolveActiveExecution?.();
      this.resolveActiveExecution = undefined;
      this.activeExecutionCompletion = undefined;
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
    this.send(createPythonToolCallNotification({ runId, callId, tool, args }));
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

  private async applyWorkerControl(command: RunControlCommand): Promise<ControlApplyResult> {
    const currentRunId = this.activeRunId ?? this.requestedRunId;
    if (!this.running || currentRunId !== command.runId) {
      return { status: "rejected", reason: `当前没有运行中的 runId：${command.runId}` };
    }
    if (command.type === "cancel") {
      if (!this.activeController) {
        return { status: "rejected", reason: `运行 ${command.runId} 没有可取消的控制器` };
      }
      return {
        status: "applied",
        afterDurable: () => this.activeController?.abort(),
      };
    }
    if (command.type === "approval") {
      const pending = this.pendingApprovals.get(command.approvalId);
      if (!pending || pending.runId !== command.runId) return "accepted";
      return {
        status: "applied",
        afterDurable: () => {
          this.pendingApprovals.delete(command.approvalId);
          pending.resolve(command.decision);
        },
      };
    }
    return { status: "rejected", reason: `${command.type} 必须由 Runtime agent queue 应用` };
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

  private close(): Promise<{ closed: true; quiescent: boolean }> {
    return this.shutdown();
  }

  /** 停止接收新请求，并等待在飞 Runtime/Environment 完成自己的 finally 清理。 */
  async shutdown(timeoutMs = 5_000): Promise<{ closed: true; quiescent: boolean }> {
    this.activeController?.abort();
    for (const approval of this.pendingApprovals.values()) approval.resolve("deny");
    for (const pending of this.pendingToolCalls.values()) {
      pending.reject(new CoreMindError("worker_closed", "worker 已关闭"));
    }
    this.pendingApprovals.clear();
    this.pendingToolCalls.clear();
    this.closed = true;
    const active = this.activeExecutionCompletion;
    if (!active) return { closed: true, quiescent: this.lastExecutionQuiescent };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const quiescent = await Promise.race([
        active.then(() => this.lastExecutionQuiescent),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      return { closed: true, quiescent };
    } finally {
      if (timer) clearTimeout(timer);
    }
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
  if (error instanceof ProtocolCursorExpiredError) {
    return createErrorResponse(id, -32_000, error.message, "cursor_expired", {
      recovery: error.recovery,
    });
  }
  if (error instanceof ProtocolValidationError) {
    return createErrorResponse(id, -32_600, error.message, "protocol_validation_failed");
  }
  if (error instanceof ProtocolV2ValidationError) {
    return createErrorResponse(id, -32_600, error.message, "protocol_validation_failed");
  }
  if (error instanceof ProtocolV2NegotiationError) {
    return createErrorResponse(id, -32_601, error.message, error.code);
  }
  const classification = classifyExecutionError(error);
  return createErrorResponse(
    id,
    -32_000,
    classification.message,
    classification.code,
    classification.audit ? { audit: classification.audit } : undefined,
  );
}

class ProtocolCursorExpiredError extends CoreMindError {
  constructor(
    readonly recovery: {
      runId: string;
      newCursor: number;
      derivedFromSequence: number;
      projection: unknown;
    },
  ) {
    super("cursor_expired", `事件 cursor 已过期；最早可恢复 cursor 为 ${recovery.newCursor}`);
  }
}

function validateProtocolEventWindow(window: ProtocolEventWindow, latestSequence: number): void {
  if (
    !Number.isInteger(window.retainedFromSequence) ||
    window.retainedFromSequence < 1 ||
    !Number.isInteger(window.latestSequence) ||
    window.latestSequence !== latestSequence ||
    window.records.some(
      (record) =>
        record.sequence < window.retainedFromSequence || record.sequence > window.latestSequence,
    )
  ) {
    throw new CoreMindError("run_state_corrupt", "事件保留窗口与权威 Run Facts 不一致");
  }
}

function isProtocolV2Initialize(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const request = value as { method?: unknown; params?: unknown };
  if (
    request.method !== "initialize" ||
    request.params === null ||
    typeof request.params !== "object"
  ) {
    return false;
  }
  return "protocolRange" in request.params;
}

function isProtocolV2Envelope(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { protocolVersion?: unknown }).protocolVersion === "2.0"
  );
}

function toV1InitializeParams(
  params: ProtocolV2InitializeRequest["params"],
): Extract<ProtocolRequest, { method: "initialize" }>["params"] {
  return {
    protocolVersion: PROTOCOL_VERSION,
    ...(params.config !== undefined
      ? { config: params.config }
      : { configPath: params.configPath! }),
    ...(params.configDir !== undefined ? { configDir: params.configDir } : {}),
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
  };
}

function protocolV2StartFingerprint(request: ProtocolV2StartRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        method: request.method,
        params: request.params,
      }),
    )
    .digest("hex");
}

function protocolV2RunHandle(runId: string, acceptedAt: string): ProtocolV2RunHandle {
  return {
    runId,
    acceptedAt,
    initialCursor: 0,
    selectedProtocol: "2.0",
    availableControls: [...PROTOCOL_V2_AVAILABLE_CONTROLS],
  };
}

function persistedProtocolV2Start(records: RunStateRecord[]): ProtocolStartIdentity | undefined {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!;
    if (record.kind !== "start" && record.kind !== "resume") continue;
    const payload = asRecord(record.payload);
    const identity = payload ? asRecord(payload.protocolStart) : undefined;
    if (
      identity?.protocolVersion === "2.0" &&
      (identity.method === "run" || identity.method === "chat" || identity.method === "resume") &&
      typeof identity.fingerprint === "string" &&
      identity.fingerprint.length > 0 &&
      typeof identity.acceptedAt === "string" &&
      identity.acceptedAt.length > 0
    ) {
      return identity as unknown as ProtocolStartIdentity;
    }
  }
  return undefined;
}

function toProtocolV2Event(record: RunStateRecord): unknown {
  const trace = record.kind === "event" ? asRecord(record.payload) : undefined;
  const event = trace ? asRecord(trace.event) : undefined;
  const payload = event ?? record.payload;
  const identity = event ?? asRecord(record.payload);
  return {
    protocolVersion: "2.0" as const,
    eventType: event && typeof event.type === "string" ? event.type : `fact.${record.kind}`,
    eventSchemaVersion: 1 as const,
    runId: record.runId,
    sequence: record.sequence,
    eventId:
      record.eventId ??
      (trace && typeof trace.eventId === "string"
        ? trace.eventId
        : `legacy:${record.runId}:${record.sequence}`),
    timestamp: record.timestamp,
    ...eventIdentity(identity),
    payload: structuredClone(payload),
    ignorable: false,
    sensitivity: "local" as const,
  };
}

function eventIdentity(value: Record<string, unknown> | undefined): Record<string, string> {
  if (!value) return {};
  const result: Record<string, string> = {};
  for (const key of [
    "turnId",
    "stepId",
    "callId",
    "approvalId",
    "receiptId",
    "parentRunId",
    "childRunId",
    "delegationId",
  ] as const) {
    if (typeof value[key] === "string") result[key] = value[key];
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export { ProtocolHost as WorkerServer };

import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Ajv, type ValidateFunction } from "ajv";
import { resolveRuntimeLimits } from "./budget.js";
import { canonicalJson } from "./canonical-json.js";
import { projectEffectReceiptBindings } from "./effect-receipt-binding.js";
import { CoreMindRuntime, type CoreMindRuntimeOptions, type RunResult } from "./runtime.js";
import { assertJsonSerializable } from "./session-v4/session/session.js";
import type { JsonValue } from "./session-v4/session/types.js";
import {
  type TaskCheckpoint,
  TaskCommitSession,
  type TaskConversationEntry,
  type TaskDocument,
  type TaskDocumentSchema,
} from "./task-commit.js";

export type TaskExecutionErrorCode =
  | "task_definition_invalid"
  | "task_definition_unknown"
  | "task_definition_mismatch"
  | "task_authority_mismatch"
  | "task_checkpoint_invalid"
  | "task_migration_failed"
  | "task_not_found"
  | "task_already_exists"
  | "task_busy"
  | "task_closed"
  | "task_cancelled"
  | "task_phase_timeout"
  | "task_run_unresolved"
  | "task_run_failed";

export class TaskExecutionError extends Error {
  constructor(
    readonly code: TaskExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskExecutionError";
  }
}

export interface TaskSnapshot {
  taskId: string;
  type: string;
  version: number;
  phase: string;
  status: "ready" | "paused" | "completed" | "cancelled";
  checkpoint: JsonValue;
  /** 存在时禁止自动重发 Run；须先核对原 Run 的 Facts 与副作用回执。 */
  pendingRunId?: string;
}

export interface TaskTransition {
  phase: string;
  checkpoint: JsonValue;
  done?: boolean;
  documents?: TaskDocument[];
  entries?: TaskConversationEntry[];
}

export interface TaskPhaseContext {
  readonly task: TaskSnapshot;
  readonly signal: AbortSignal;
  /** 每阶段最多一次完整受治理 Run；不暴露裸模型或工具执行器。 */
  run(prompt: string): Promise<RunResult>;
}

export interface TaskDefinition {
  type: string;
  version: number;
  initialPhase: string;
  checkpointSchema: Record<string, unknown>;
  phases: Record<string, (context: TaskPhaseContext) => TaskTransition | Promise<TaskTransition>>;
  /** 只转换旧阶段与检查点；不接收 Runtime、权限、工具或预算入口。 */
  migrate?: (
    previous: TaskSnapshot,
    signal: AbortSignal,
  ) =>
    | Pick<TaskTransition, "phase" | "checkpoint">
    | Promise<Pick<TaskTransition, "phase" | "checkpoint">>;
}

export interface TaskRuntimeOptions
  extends Pick<
    CoreMindRuntimeOptions,
    | "config"
    | "configDir"
    | "env"
    | "toolEnv"
    | "approveTool"
    | "approveProjectCode"
    | "toolDefinitions"
    | "lifecycleExtensions"
    | "maxSteps"
    | "stepTimeoutMs"
  > {
  /** 宿主须在回调闭包、凭据路由或外部策略改变时更新此身份。 */
  authorityVersion: string;
}

export interface TaskSessionOptions {
  workspace: string;
  sessionId: string;
  definitions: readonly TaskDefinition[];
  documentSchemas?: readonly TaskDocumentSchema[];
  /** 纯状态任务可省略；调用 context.run 时必须提供。 */
  runtime?: TaskRuntimeOptions;
}

interface TaskState {
  format: 1;
  authority: string;
  definition: string;
  status: TaskSnapshot["status"];
  checkpoint: JsonValue;
  pendingRunId?: string;
}

interface RegisteredTask {
  definition: TaskDefinition;
  fingerprint: string;
  validate: ValidateFunction;
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const stateValidator = new Ajv({ strict: true, ownProperties: true }).compile({
  type: "object",
  additionalProperties: false,
  required: ["format", "authority", "definition", "status", "checkpoint"],
  properties: {
    format: { const: 1 },
    authority: { type: "string", pattern: "^[a-f0-9]{64}$" },
    definition: { type: "string", pattern: "^[a-f0-9]{64}$" },
    status: { enum: ["ready", "paused", "completed", "cancelled"] },
    checkpoint: {},
    pendingRunId: { type: "string", pattern: "^[a-zA-Z0-9_-]+$", maxLength: 128 },
  },
});

/** 宿主显式驱动的阶段控制器；每次 resume 只有一个阶段提交，不恢复 JS 栈。 */
export class TaskSession {
  private active?: { taskId: string; controller: AbortController; promise: Promise<TaskSnapshot> };
  private closing?: Promise<void>;

  private constructor(
    private readonly commits: TaskCommitSession,
    private readonly definitions: Map<string, RegisteredTask>,
    private readonly workspace: string,
    private readonly runtime: TaskRuntimeOptions | undefined,
    private readonly authority: string,
    private readonly phaseTimeoutMs: number,
  ) {}

  static async open(options: TaskSessionOptions): Promise<TaskSession> {
    const definitions = register(options.definitions);
    const workspace = await realpath(options.workspace);
    const runtime = options.runtime ? copyRegistration(options.runtime) : undefined;
    if (
      runtime &&
      (typeof runtime.authorityVersion !== "string" ||
        !ID.test(runtime.authorityVersion) ||
        !runtime.configDir ||
        Object.keys(runtime).some(
          (key) =>
            ![
              "authorityVersion",
              "config",
              "configDir",
              "env",
              "toolEnv",
              "approveTool",
              "approveProjectCode",
              "toolDefinitions",
              "lifecycleExtensions",
              "maxSteps",
              "stepTimeoutMs",
            ].includes(key),
        ))
    )
      throw failure("task_definition_invalid", "Runtime 必须提供 authorityVersion 和 configDir");
    if (runtime) runtime.configDir = await realpath(runtime.configDir);
    const limits = resolveRuntimeLimits(runtime?.config.runtime, {
      stepTimeoutMs: runtime?.stepTimeoutMs,
      maxSteps: runtime?.maxSteps,
    });
    if (
      !Number.isSafeInteger(limits.stepTimeoutMs) ||
      limits.stepTimeoutMs < 0 ||
      limits.stepTimeoutMs > 2_147_483_647
    )
      throw failure("task_definition_invalid", "阶段超时须为非负安全整数");
    const authority = fingerprint(runtime ?? null);
    const commits = await TaskCommitSession.open({
      workspace,
      sessionId: options.sessionId,
      documentSchemas: options.documentSchemas ?? [],
    });
    return new TaskSession(
      commits,
      definitions,
      workspace,
      runtime,
      authority,
      limits.stepTimeoutMs,
    );
  }

  query(taskId: string): TaskSnapshot | undefined {
    this.assertOpen();
    const record = this.record(taskId);
    return record ? snapshot(taskId, record) : undefined;
  }

  start(input: { taskId: string; type: string; checkpoint: JsonValue }): Promise<TaskSnapshot> {
    return this.exclusive(input.taskId, async (controller) => {
      assertActive(controller.signal);
      if (this.record(input.taskId)) throw failure("task_already_exists", "taskId 已存在");
      const registered = this.definition(input.type);
      const checkpoint = copyJson(input.checkpoint);
      validateCheckpoint(registered, registered.definition.initialPhase, checkpoint);
      await this.persist(input.taskId, {
        type: input.type,
        version: registered.definition.version,
        phase: registered.definition.initialPhase,
        checkpoint: asJson({
          format: 1,
          authority: this.authority,
          definition: registered.fingerprint,
          status: "ready",
          checkpoint,
        }),
      });
      return snapshot(input.taskId, this.requiredRecord(input.taskId));
    });
  }

  resume(taskId: string): Promise<TaskSnapshot> {
    return this.exclusive(taskId, async (controller) => {
      let record = this.requiredRecord(taskId);
      let state = readState(record);
      if (state.status === "completed" || state.status === "cancelled")
        return snapshot(taskId, record);
      if (state.authority !== this.authority)
        throw failure(
          "task_authority_mismatch",
          "任务权限/配置身份变化，不能通过状态迁移授予新权限",
        );
      const registered = this.definition(record.type);
      if (state.pendingRunId)
        throw failure("task_run_unresolved", "阶段已有未提交 Run，必须核对原 Run，禁止自动重发");
      if (record.version !== registered.definition.version) {
        const migrate = registered.definition.migrate;
        if (!migrate || record.version > registered.definition.version)
          throw failure("task_definition_mismatch", "任务版本变化且无显式向前迁移");
        let migrated: Pick<TaskTransition, "phase" | "checkpoint">;
        try {
          migrated = copyJson(
            await bounded(
              () => migrate(snapshot(taskId, record), controller.signal),
              controller,
              this.phaseTimeoutMs,
            ),
          );
          if (Object.keys(migrated).some((key) => key !== "phase" && key !== "checkpoint"))
            throw failure("task_checkpoint_invalid", "迁移只能返回 phase 与 checkpoint");
          validateCheckpoint(registered, migrated.phase, migrated.checkpoint);
        } catch {
          throw failure("task_migration_failed", "迁移失败，原任务事实保持不变");
        }
        assertActive(controller.signal);
        record = {
          ...record,
          version: registered.definition.version,
          phase: migrated.phase,
          checkpoint: asJson({
            ...state,
            definition: registered.fingerprint,
            checkpoint: migrated.checkpoint,
          }),
        };
        await this.persist(taskId, record);
        state = readState(record);
      } else if (state.definition !== registered.fingerprint) {
        throw failure("task_definition_mismatch", "同版本任务定义已变化；请提升版本并显式迁移");
      }
      validateCheckpoint(registered, record.phase, state.checkpoint);
      let accepting = true;
      let run: Promise<RunResult> | undefined;
      let succeeded = false;
      const context: TaskPhaseContext = {
        task: snapshot(taskId, record),
        signal: controller.signal,
        run: (prompt) => {
          if (!accepting || controller.signal.aborted)
            return Promise.reject(failure("task_cancelled", "阶段已停止接收调用"));
          if (run) return Promise.reject(failure("task_run_unresolved", "每阶段只能启动一次 Run"));
          if (!this.runtime || typeof prompt !== "string" || !prompt.trim())
            return Promise.reject(
              failure("task_definition_invalid", "调用 Run 须配置 Runtime 并提供非空 prompt"),
            );
          run = (async () => {
            state = { ...state, pendingRunId: randomUUID() };
            record = { ...record, checkpoint: asJson(state) };
            await this.persist(taskId, record);
            assertActive(controller.signal);
            const runtime = await CoreMindRuntime.create({
              ...this.runtime!,
              cwd: this.workspace,
              runId: state.pendingRunId,
              initialPrompt: prompt,
              signal: controller.signal,
            });
            const result = await runtime.run();
            const effects = projectEffectReceiptBindings(result.trace.map((entry) => entry.event));
            succeeded =
              result.outcome.status === "succeeded" &&
              effects.every((effect) => effect.status === "committed") &&
              (await runtime.waitForQuiescence(0));
            if (!succeeded) throw failure("task_run_failed", "受治理 Run 未成功，不能推进阶段");
            return result;
          })();
          // 调用者遗漏 await 也不允许逃逸提交；最终必须等待受治理 Run 收敛。
          void run.catch(() => undefined);
          return run;
        },
      };
      try {
        const transition = await bounded(
          async () => {
            const result = copyJson(await registered.definition.phases[record.phase]!(context));
            accepting = false;
            if (run) await run;
            return result;
          },
          controller,
          this.phaseTimeoutMs,
        );
        assertActive(controller.signal);
        if (state.pendingRunId && !succeeded) throw failure("task_run_failed", "Run 未成功");
        if (
          Object.keys(transition).some(
            (key) => !["phase", "checkpoint", "done", "documents", "entries"].includes(key),
          ) ||
          (transition.done !== undefined && typeof transition.done !== "boolean")
        )
          throw failure("task_checkpoint_invalid", "阶段结果字段无效");
        validateCheckpoint(registered, transition.phase, transition.checkpoint);
        const next: TaskState = {
          format: 1,
          authority: state.authority,
          definition: state.definition,
          status: transition.done ? "completed" : "ready",
          checkpoint: transition.checkpoint,
        };
        await this.persist(
          taskId,
          { ...record, phase: transition.phase, checkpoint: asJson(next) },
          transition,
        );
        return snapshot(taskId, this.requiredRecord(taskId));
      } catch (error) {
        accepting = false;
        controller.abort(error);
        if (run) await run.catch(() => undefined);
        // 保留已提交检查点与 Run 标识；异常不是阶段成功。
        const latest = this.requiredRecord(taskId);
        await this.persist(taskId, {
          ...latest,
          checkpoint: asJson({
            ...readState(latest),
            status:
              error instanceof TaskExecutionError && error.code === "task_cancelled"
                ? "cancelled"
                : "paused",
          }),
        });
        throw error;
      } finally {
        accepting = false;
      }
    });
  }

  async cancel(taskId: string): Promise<TaskSnapshot> {
    this.assertOpen();
    if (this.active?.taskId === taskId) {
      this.active.controller.abort(failure("task_cancelled", "宿主取消任务"));
      await this.active.promise.catch(() => undefined);
    }
    return this.exclusive(taskId, async () => {
      const record = this.requiredRecord(taskId);
      const state = readState(record);
      if (state.status !== "completed" && state.status !== "cancelled")
        await this.persist(taskId, {
          ...record,
          checkpoint: asJson({ ...state, status: "cancelled" }),
        });
      return snapshot(taskId, this.requiredRecord(taskId));
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const active = this.active;
      active?.controller.abort(failure("task_cancelled", "任务会话关闭"));
      await active?.promise.catch(() => undefined);
      await this.commits.close();
    })();
    return this.closing;
  }

  private assertOpen(): void {
    if (this.closing) throw failure("task_closed", "任务会话已关闭");
  }

  private definition(type: string): RegisteredTask {
    const registered = this.definitions.get(type);
    if (!registered) throw failure("task_definition_unknown", "任务类型未由宿主注册");
    return registered;
  }

  private record(taskId: string): TaskCheckpoint | undefined {
    if (typeof taskId !== "string" || !ID.test(taskId))
      throw failure("task_checkpoint_invalid", "taskId 无效");
    const tasks = this.commits.snapshot().tasks;
    return Object.hasOwn(tasks, taskId) ? tasks[taskId] : undefined;
  }

  private requiredRecord(taskId: string): TaskCheckpoint {
    const record = this.record(taskId);
    if (!record) throw failure("task_not_found", "任务不存在");
    return record;
  }

  private persist(
    taskId: string,
    task: TaskCheckpoint,
    additions?: Pick<TaskTransition, "documents" | "entries">,
  ): Promise<unknown> {
    return this.commits.commit({
      schemaVersion: 1,
      commitId: randomUUID(),
      expectedRevision: this.commits.snapshot().revision,
      taskId,
      task,
      documents: additions?.documents ?? [],
      entries: additions?.entries ?? [],
    });
  }

  private exclusive(
    taskId: string,
    operation: (controller: AbortController) => Promise<TaskSnapshot>,
  ): Promise<TaskSnapshot> {
    this.assertOpen();
    if (this.active) return Promise.reject(failure("task_busy", "任务会话已有活动操作"));
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => operation(controller));
    this.active = { taskId, controller, promise };
    return promise.finally(() => {
      this.active = undefined;
    });
  }
}

function register(definitions: readonly TaskDefinition[]): Map<string, RegisteredTask> {
  const result = new Map<string, RegisteredTask>();
  if (!Array.isArray(definitions))
    throw failure("task_definition_invalid", "definitions 必须为数组");
  for (const input of definitions) {
    const definition = copyRegistration(input);
    if (
      !definition ||
      typeof definition.type !== "string" ||
      !ID.test(definition.type) ||
      !Number.isSafeInteger(definition.version) ||
      definition.version < 1 ||
      result.has(definition.type) ||
      !definition.phases ||
      typeof definition.initialPhase !== "string" ||
      !ID.test(definition.initialPhase) ||
      !Object.hasOwn(definition.phases, definition.initialPhase) ||
      Object.entries(definition.phases).some(
        ([name, handler]) => !ID.test(name) || typeof handler !== "function",
      ) ||
      (definition.migrate !== undefined && typeof definition.migrate !== "function")
    )
      throw failure("task_definition_invalid", "任务类型、版本、阶段或处理器无效");
    try {
      const schema = copyJson(definition.checkpointSchema);
      if (!schema || typeof schema !== "object" || Array.isArray(schema))
        throw new Error("非对象 Schema");
      const validate = new Ajv({ strict: true, ownProperties: true, logger: false }).compile(
        schema,
      );
      if ("$async" in validate && validate.$async) throw new Error("异步 Schema");
      result.set(definition.type, { definition, validate, fingerprint: fingerprint(definition) });
    } catch {
      throw failure("task_definition_invalid", "checkpointSchema 必须为同步 JSON Schema draft-07");
    }
  }
  return result;
}

function validateCheckpoint(
  registered: RegisteredTask,
  phase: string,
  checkpoint: JsonValue,
): void {
  if (
    typeof phase !== "string" ||
    !Object.hasOwn(registered.definition.phases, phase) ||
    !registered.validate(copyJson(checkpoint))
  )
    throw failure("task_checkpoint_invalid", "阶段不存在或检查点不符合 Schema");
}

function readState(record: TaskCheckpoint): TaskState {
  if (!stateValidator(record.checkpoint))
    throw failure("task_checkpoint_invalid", "任务状态封装损坏或版本不支持");
  return record.checkpoint as unknown as TaskState;
}

function snapshot(taskId: string, record: TaskCheckpoint): TaskSnapshot {
  const state = readState(record);
  return copyJson({
    taskId,
    type: record.type,
    version: record.version,
    phase: record.phase,
    status: state.status,
    checkpoint: state.checkpoint,
    ...(state.pendingRunId ? { pendingRunId: state.pendingRunId } : {}),
  });
}

function copyJson<T>(value: T): T {
  try {
    assertJsonSerializable(value);
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    throw failure("task_checkpoint_invalid", "任务数据必须为有限且无访问器的 JSON");
  }
}

function asJson(value: TaskState): JsonValue {
  return copyJson(value) as unknown as JsonValue;
}

/** 注册只复制普通数据与可信函数引用；拒绝访问器，不执行来自持久状态的代码。 */
function copyRegistration<T>(value: T, active = new Set<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (
    active.has(value) ||
    (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw failure("task_definition_invalid", "注册项必须为无环普通对象");
  active.add(value);
  const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === "length") continue;
    if (!("value" in descriptor)) throw failure("task_definition_invalid", "注册项不允许访问器");
    Object.defineProperty(output, key, {
      value: copyRegistration(descriptor.value, active),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  active.delete(value);
  return output as T;
}

function fingerprint(value: unknown): string {
  const data: unknown = JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "function"
        ? { trustedFunction: Function.prototype.toString.call(item) }
        : item,
    ),
  );
  return createHash("sha256").update(canonicalJson(data), "utf8").digest("hex");
}

function failure(code: TaskExecutionErrorCode, message: string): TaskExecutionError {
  return new TaskExecutionError(code, message);
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

async function bounded<T>(
  operation: () => T | Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  assertActive(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0)
      timer = setTimeout(
        () => controller.abort(failure("task_phase_timeout", "任务阶段超过既定步骤超时")),
        timeoutMs,
      );
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

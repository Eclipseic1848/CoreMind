import { createHash } from "node:crypto";
import type { AgentDriverToolResult } from "./agent-driver.js";
import { canonicalJson } from "./canonical-json.js";
import type { CoreMindMessageContent } from "./public-message.js";
import { assertJsonSerializable } from "./session-v4/session/session.js";
import type { JsonValue } from "./session-v4/session/types.js";
import { redactSensitiveText } from "./trace.js";

export interface TaskToolResult {
  content: CoreMindMessageContent[];
  details: JsonValue;
}

export interface TaskCallContext {
  /** 同一阶段 Run 内串行调用；重复 key 连接同一在飞调用或复用已提交结果。 */
  executeTool(key: string, tool: string, args: JsonValue): Promise<TaskToolResult>;
}

export class TaskCallError extends Error {
  constructor(
    readonly code: "task_call_conflict" | "task_call_unresolved" | "task_call_failed",
    message: string,
  ) {
    super(message);
    this.name = "TaskCallError";
  }
}

interface TaskCallRecord {
  key: string;
  tool: string;
  args: JsonValue;
  signature: string;
  stepId: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  result?: TaskToolResult;
  error?: string;
}

export interface TaskCallSnapshot extends TaskCallRecord {
  runId: string;
  phase: string;
  version: number;
  /** 包含注册工具能力、配置与回调版本的完整权限指纹。 */
  authority: string;
}

export interface TaskCallGroup {
  runId: string;
  phase: string;
  version: number;
  authority: string;
  calls: TaskCallRecord[];
  conflict?: string;
}

const id = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$" };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
export const taskCallGroupsSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["runId", "phase", "version", "authority", "calls"],
    properties: {
      runId: id,
      phase: id,
      version: { type: "integer", minimum: 1 },
      authority: hash,
      conflict: { type: "string" },
      calls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "tool", "args", "signature", "stepId", "status"],
          properties: {
            key: id,
            tool: { type: "string", minLength: 1 },
            args: {},
            signature: hash,
            stepId: hash,
            status: { enum: ["pending", "completed", "failed", "cancelled"] },
            error: { type: "string" },
            result: {
              type: "object",
              additionalProperties: false,
              required: ["content", "details"],
              properties: { content: { type: "array", items: { type: "object" } }, details: {} },
            },
          },
        },
      },
    },
  },
};

export function copyTaskValue<T>(value: T): T {
  assertJsonSerializable(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function executeTaskCalls<T extends JsonValue>(options: {
  group: TaskCallGroup;
  signal: AbortSignal;
  persist(): Promise<unknown>;
  invoke?: (stepId: string, tool: string, args: JsonValue) => Promise<AgentDriverToolResult>;
  handler: (calls: TaskCallContext) => Promise<T>;
}): Promise<T> {
  const { group, signal } = options;
  const initialCount = group.calls.length;
  let cursor = 0;
  let open = true;
  let activeKey: string | undefined;
  let fatal: unknown;
  const admitted = new Map<string, Promise<TaskToolResult>>();
  const signatures = new Map<string, string>();
  const audits: Promise<never>[] = [];
  const handled = <V>(promise: Promise<V>): Promise<V> => {
    void promise.catch(() => undefined);
    return promise;
  };
  const conflict = (message: string): Promise<never> => {
    const error = new TaskCallError("task_call_conflict", message);
    fatal ??= error;
    group.conflict = message;
    // 与当前写入串行，避免审计覆盖尚在提交的结果。
    const audit = handled(
      Promise.allSettled([...admitted.values(), ...audits]).then(async () => {
        await options.persist();
        throw error;
      }),
    );
    audits.push(audit);
    return audit;
  };
  const calls: TaskCallContext = {
    executeTool: (key, tool, rawArgs) => {
      if (!open || signal.aborted || fatal)
        return handled(
          Promise.reject(fatal ?? new TaskCallError("task_call_unresolved", "阶段已停止接收调用")),
        );
      let args: JsonValue;
      try {
        args = copyTaskValue(rawArgs);
        if (redactSensitiveText(JSON.stringify(args)) !== JSON.stringify(args))
          throw new Error("调用参数含凭据，不能持久化");
        if (
          typeof key !== "string" ||
          !new RegExp(id.pattern).test(key) ||
          typeof tool !== "string" ||
          !tool
        )
          throw new Error("调用身份无效");
      } catch {
        return conflict("调用 key、工具或参数无效");
      }
      const signature = createHash("sha256")
        .update(canonicalJson({ key, tool, args, authority: group.authority }), "utf8")
        .digest("hex");
      const previous = group.calls.find((call) => call.key === key);
      if (previous && previous.signature !== signature)
        return conflict(`稳定键 ${key} 的工具、参数或权限身份已变化`);
      const joined = admitted.get(key);
      if (joined && signatures.get(key) !== signature)
        return conflict(`稳定键 ${key} 的在飞参数发生分歧`);
      if (joined) return handled(joined.then(copyTaskValue));
      if (activeKey) return conflict("不同稳定键必须串行执行，不能绕过同一 Run 的预算与顺序");
      if (
        (cursor < initialCount && group.calls[cursor]?.key !== key) ||
        (!previous && !options.invoke)
      )
        return conflict(`恢复调用顺序发生分歧：${key}`);
      cursor += 1;
      const call: TaskCallRecord = previous ?? {
        key,
        tool,
        args,
        signature,
        stepId: createHash("sha256").update(`${group.runId}:${key}`, "utf8").digest("hex"),
        status: "pending",
      };
      activeKey = key;
      const pending = Promise.resolve()
        .then(async () => {
          if (call.status === "completed" && call.result) return copyTaskValue(call.result);
          if (call.status !== "pending" || !options.invoke)
            throw new TaskCallError("task_call_unresolved", `调用 ${key} 没有可复用的成功结果`);
          if (!previous) {
            group.calls.push(call);
            await options.persist();
          }
          signal.throwIfAborted();
          try {
            const result = await options.invoke(call.stepId, tool, copyTaskValue(args));
            signal.throwIfAborted();
            call.result = copyTaskValue({
              content: result.content,
              details: result.details ?? null,
            }) as TaskToolResult;
            call.status = "completed";
            await options.persist();
            return copyTaskValue(call.result);
          } catch (error) {
            call.status = signal.aborted ? "cancelled" : "failed";
            // 不把可能含凭据的任意错误正文写入任务账本；原错误身份留在 Run Facts。
            call.error = signal.aborted ? "task_cancelled" : "task_call_failed";
            await options.persist();
            throw error;
          }
        })
        .catch((error: unknown) => {
          fatal ??= error;
          throw error;
        })
        .finally(() => {
          activeKey = undefined;
        });
      admitted.set(key, pending);
      signatures.set(key, signature);
      void pending.catch(() => undefined);
      return handled(pending.then(copyTaskValue));
    },
  };
  try {
    const value = await options.handler(calls);
    open = false;
    await Promise.all([...admitted.values()]);
    if (fatal) throw fatal;
    if (cursor < initialCount) return await conflict("恢复处理器遗漏已记录的调用");
    signal.throwIfAborted();
    return copyTaskValue(value);
  } finally {
    open = false;
    await Promise.allSettled([...admitted.values()]);
    await Promise.allSettled(audits);
  }
}

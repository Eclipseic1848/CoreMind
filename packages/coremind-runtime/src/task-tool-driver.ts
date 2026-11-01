import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { toToolDeclaration } from "@earendil-works/pi-ai";
import { Ajv } from "ajv";
import type { AgentDriver, AgentDriverToolResult } from "./agent-driver.js";
import type { AgentBuildContext } from "./agent-factory.js";
import { CoreMindError } from "./errors.js";

export interface TaskToolRequest {
  tool: string;
  args: unknown;
  accept(result: AgentDriverToolResult): void;
}

/** 仅由任务 Run 注入的精确工具入口；执行仍通过原 Harness 和 ToolExecutionEngine。 */
export function buildTaskToolDriver(
  ctx: Pick<AgentBuildContext, "tools" | "agentName" | "harness" | "onEvent">,
  request: TaskToolRequest,
): AgentDriver {
  const harness = ctx.harness!;
  const controller = new AbortController();
  let running = false;
  let active = Promise.resolve();
  const catalog = ctx.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    declaration: toToolDeclaration(tool),
  }));
  const selection = harness.registerDeclarationCatalog?.(catalog);
  const emit = ctx.onEvent;
  const agent = ctx.agentName;
  const execute = async () => {
    await harness.beforePrompt?.();
    controller.signal.throwIfAborted();
    const matches = ctx.tools.filter((tool) => tool.name === request.tool);
    if (matches.length !== 1) throw new CoreMindError("invalid_tool", "任务工具不属于唯一注册目录");
    const tool: AgentTool = matches[0]!;
    const call = { callId: randomUUID(), tool: tool.name, args: request.args };
    emit({ type: "agent_start", agent });
    harness.onObservation?.({ type: "agent_start" });
    emit({ type: "tool_call", agent, ...call });
    harness.onObservation?.({ type: "tool_execution_start", call });
    let result: AgentDriverToolResult = {
      content: [{ type: "text", text: "工具未完成" }],
      details: {},
    };
    let error: unknown;
    let admitted = false;
    try {
      if (selection && !selection.names.includes(tool.name))
        throw new CoreMindError("tool_capability_conflict", "任务工具未进入当前声明集合");
      if (!new Ajv({ strict: false, ownProperties: true }).validate(tool.parameters, call.args))
        throw new CoreMindError("invalid_tool", "任务工具参数不符合注册 Schema");
      const decision = await harness.beforeToolCall!({ toolCall: call }, controller.signal);
      if (decision?.block)
        throw new CoreMindError("tool_execution_failed", decision.reason ?? "工具准入被拒绝");
      admitted = true;
      controller.signal.throwIfAborted();
      result = await harness.executeTool!({
        call,
        signal: controller.signal,
        invoke: () =>
          tool.execute(call.callId, call.args, controller.signal) as Promise<AgentDriverToolResult>,
      });
    } catch (caught) {
      error = caught;
    }
    let isError = error !== undefined || (result as { isError?: boolean }).isError === true;
    try {
      if (admitted) {
        const changed = await harness.afterToolCall!(
          { toolCall: call, result, isError },
          controller.signal,
        );
        result = {
          content: changed?.content ?? result.content,
          details: changed?.details ?? result.details,
        };
        isError = changed?.isError ?? isError;
      }
    } catch (caught) {
      error ??= caught;
      isError = true;
    } finally {
      harness.onObservation?.({ type: "tool_execution_end", call, result, isError });
      emit({ type: "tool_result", agent, tool: call.tool, callId: call.callId, isError });
      emit({ type: "agent_end", agent });
      harness.onObservation?.({ type: "agent_end" });
    }
    harness.throwIfDenied?.();
    harness.throwIfContextFailed?.();
    if (error) throw error;
    if (isError) throw new CoreMindError("tool_execution_failed", "任务工具报告失败");
    controller.signal.throwIfAborted();
    request.accept(result);
    harness.onPromptCompleted?.();
  };
  return {
    prompt: () => {
      if (running) return Promise.reject(new CoreMindError("run_id_conflict", "工具调用已开始"));
      running = true;
      active = execute().finally(() => {
        running = false;
      });
      return active;
    },
    waitForIdle: () => active,
    messages: () => [],
    status: () => ({ running, pendingToolCalls: running ? 1 : 0, queuedControls: 0 }),
    abort: () => controller.abort(),
    canAcceptControl: () => false,
    queueControl: () => {
      throw new CoreMindError("invalid_config", "精确任务调用不接收模型控制输入");
    },
    clearQueuedControls: () => {},
  };
}

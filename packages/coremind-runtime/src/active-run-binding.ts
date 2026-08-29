import type { CallId } from "./ids.js";
import type { RunProjection } from "./projection.js";

export interface DelegationExecutionOutput {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

interface ActiveRunBindings {
  inspectProjection: () => Promise<RunProjection | undefined>;
  executeDelegation: (
    parentAgentName: string,
    rawArgs: unknown,
    callId: CallId,
  ) => Promise<DelegationExecutionOutput>;
  executeDelegationDisposition: (
    parentAgentName: string,
    rawArgs: unknown,
    callId: CallId,
  ) => Promise<DelegationExecutionOutput>;
}

const activeBindings = new WeakMap<object, ActiveRunBindings>();

/** 把隔离 Turn Runtime 的最小能力绑定到创建它的会话 Runtime。 */
export function bindActiveRun(owner: object, bindings: ActiveRunBindings): () => void {
  activeBindings.set(owner, bindings);
  return () => {
    if (activeBindings.get(owner) === bindings) activeBindings.delete(owner);
  };
}

/** 查询当前绑定的 Projection；不触发 journal flush 或访问执行器私有状态。 */
export function inspectBoundRunProjection(owner: object): Promise<RunProjection | undefined> {
  return activeBindings.get(owner)?.inspectProjection() ?? Promise.resolve(undefined);
}

/** 把创建期闭包收到的委派转交给真正拥有活动 RunContext 的 Turn Runtime。 */
export function boundDelegationExecutor(
  owner: object,
): ActiveRunBindings["executeDelegation"] | undefined {
  return activeBindings.get(owner)?.executeDelegation;
}

/** 把创建期闭包收到的处置调用转交给真正拥有活动 RunContext 的 Turn Runtime。 */
export function boundDelegationDispositionExecutor(
  owner: object,
): ActiveRunBindings["executeDelegationDisposition"] | undefined {
  return activeBindings.get(owner)?.executeDelegationDisposition;
}

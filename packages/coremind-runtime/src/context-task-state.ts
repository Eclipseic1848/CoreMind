import { canonicalJson } from "./canonical-json.js";
import type { ContextTaskState, ContextTaskStateSourceFacts } from "./context-lifecycle.js";
import type { CoreMindTraceEvent } from "./trace.js";

export interface ContextPlanStep {
  id: string;
  type: string;
  steps?: readonly ContextPlanStep[];
  then?: readonly ContextPlanStep[];
  else?: readonly ContextPlanStep[];
  cases?: Readonly<Record<string, readonly ContextPlanStep[]>>;
  default?: readonly ContextPlanStep[];
}

export interface ContextTaskStateProjectionInput {
  runId: string;
  agentName: string;
  initialPrompt?: string;
  projectInstructions?: string;
  permissions?: unknown;
  workflowSteps?: readonly ContextPlanStep[];
  trace: readonly CoreMindTraceEvent[];
}

/** 从持久 Run/Config/Trace Facts 投影 TaskState；不从自然语言正文猜测字段。 */
export function projectContextTaskState(input: ContextTaskStateProjectionInput): ContextTaskState {
  const sourceFacts = emptySourceFacts();
  const goal = input.initialPrompt?.trim() ?? "";
  if (goal) sourceFacts.goal.push(`run:${input.runId}:start.initialPrompt`);

  const constraints: string[] = [];
  if (input.projectInstructions?.trim()) {
    constraints.push(input.projectInstructions.trim());
    sourceFacts.constraints.push(`config:agent:${input.agentName}:systemPrompt`);
  }
  if (input.permissions !== undefined) {
    constraints.push(`权限：${canonicalJson(input.permissions)}`);
    sourceFacts.constraints.push("config:permissions");
  }

  const trace = [...input.trace].sort(
    (left, right) =>
      left.sequence - right.sequence || left.eventId.localeCompare(right.eventId, "en"),
  );
  const approvals = projectApprovals(trace, sourceFacts);
  const uncertainEffects = projectUncertainEffects(trace, sourceFacts);
  const plan = flattenPlan(input.workflowSteps ?? []);
  const { activePlan, incompleteTasks, nextStep } = projectPlan(plan, trace, sourceFacts, goal);
  const modifiedFiles = projectModifiedFiles(trace, sourceFacts);
  const tests = projectTests(trace, sourceFacts);

  return {
    goal,
    constraints,
    approvals,
    uncertainEffects,
    activePlan,
    modifiedFiles,
    tests,
    incompleteTasks,
    nextStep,
    sourceFacts,
  };
}

function projectApprovals(
  trace: readonly CoreMindTraceEvent[],
  sources: ContextTaskStateSourceFacts,
): string[] {
  const states = new Map<string, { status: "pending" | "allow" | "deny"; sources: string[] }>();
  for (const entry of trace) {
    const source = `trace:${entry.eventId}`;
    if (entry.event.type === "approval_required") {
      states.set(entry.event.approvalId, { status: "pending", sources: [source] });
    } else if (entry.event.type === "approval_resolved") {
      const current = states.get(entry.event.approvalId) ?? { status: "pending", sources: [] };
      current.status = entry.event.decision;
      pushUnique(current.sources, source);
      states.set(entry.event.approvalId, current);
    }
  }
  const values: string[] = [];
  for (const [approvalId, state] of states) {
    values.push(`${approvalId}:${state.status}`);
    for (const source of state.sources) pushUnique(sources.approvals, source);
  }
  return values;
}

function projectUncertainEffects(
  trace: readonly CoreMindTraceEvent[],
  sources: ContextTaskStateSourceFacts,
): string[] {
  const states = new Map<string, { status: string; source: string }>();
  for (const entry of trace) {
    if (entry.event.type !== "effect_receipt") continue;
    states.set(entry.event.idempotencyKey, {
      status: entry.event.status,
      source: `trace:${entry.eventId}`,
    });
  }
  const values: string[] = [];
  for (const [idempotencyKey, state] of states) {
    if (state.status !== "started" && state.status !== "unknown") continue;
    values.push(`${idempotencyKey}:${state.status}`);
    pushUnique(sources.uncertainEffects, state.source);
  }
  return values;
}

function projectPlan(
  plan: readonly ContextPlanStep[],
  trace: readonly CoreMindTraceEvent[],
  sources: ContextTaskStateSourceFacts,
  goal: string,
): { activePlan: string[]; incompleteTasks: string[]; nextStep: string } {
  const states = new Map<string, "pending" | "running" | "completed" | "failed">(
    plan.map((step) => [step.id, "pending"]),
  );
  const traceSources = new Map<string, string[]>();
  for (const entry of trace) {
    if (entry.event.type === "step_start") {
      states.set(entry.event.stepId, "running");
      appendMapSource(traceSources, entry.event.stepId, `trace:${entry.eventId}`);
    } else if (entry.event.type === "step_end") {
      states.set(entry.event.stepId, entry.event.ok ? "completed" : "failed");
      appendMapSource(traceSources, entry.event.stepId, `trace:${entry.eventId}`);
    }
  }

  const activePlan = plan.map((step) => `${step.id}:${states.get(step.id) ?? "pending"}`);
  const incompleteTasks = plan
    .filter((step) => states.get(step.id) !== "completed")
    .map((step) => step.id);
  for (const step of plan) {
    const configSource = `config:workflow:${step.id}`;
    pushUnique(sources.activePlan, configSource);
    for (const source of traceSources.get(step.id) ?? []) pushUnique(sources.activePlan, source);
    if (states.get(step.id) !== "completed") {
      pushUnique(sources.incompleteTasks, configSource);
      for (const source of traceSources.get(step.id) ?? []) {
        pushUnique(sources.incompleteTasks, source);
      }
    }
  }

  const nextStep = incompleteTasks[0] ?? (goal ? "完成当前 Agent Turn" : "");
  if (incompleteTasks[0]) {
    sources.nextStep.push(`config:workflow:${incompleteTasks[0]}`);
  } else if (goal) {
    sources.nextStep.push(...sources.goal);
  }
  return { activePlan, incompleteTasks, nextStep };
}

function projectModifiedFiles(
  trace: readonly CoreMindTraceEvent[],
  sources: ContextTaskStateSourceFacts,
): string[] {
  const values: string[] = [];
  for (const entry of trace) {
    if (entry.event.type !== "checkpoint_created" || !entry.event.targetPath) continue;
    pushUnique(values, entry.event.targetPath);
    pushUnique(sources.modifiedFiles, `trace:${entry.eventId}`);
  }
  return values;
}

function projectTests(
  trace: readonly CoreMindTraceEvent[],
  sources: ContextTaskStateSourceFacts,
): string[] {
  const values: string[] = [];
  for (const entry of trace) {
    if (entry.event.type === "tool_execution_evidence" && entry.event.execution.testCommand) {
      pushUnique(values, `${entry.event.tool}:exit=${entry.event.execution.exitCode ?? "unknown"}`);
      pushUnique(sources.tests, `trace:${entry.eventId}`);
    } else if (entry.event.type === "engineering_evidence") {
      pushUnique(values, `${entry.event.stepId}:${entry.event.passed ? "passed" : "failed"}`);
      pushUnique(sources.tests, `trace:${entry.eventId}`);
    }
  }
  return values;
}

function flattenPlan(steps: readonly ContextPlanStep[]): ContextPlanStep[] {
  const result: ContextPlanStep[] = [];
  const visit = (step: ContextPlanStep): void => {
    result.push(step);
    for (const child of step.steps ?? []) visit(child);
    for (const child of step.then ?? []) visit(child);
    for (const child of step.else ?? []) visit(child);
    for (const key of Object.keys(step.cases ?? {}).sort()) {
      for (const child of step.cases?.[key] ?? []) visit(child);
    }
    for (const child of step.default ?? []) visit(child);
  };
  for (const step of steps) visit(step);
  return result;
}

function emptySourceFacts(): ContextTaskStateSourceFacts {
  return {
    goal: [],
    constraints: [],
    approvals: [],
    uncertainEffects: [],
    activePlan: [],
    modifiedFiles: [],
    tests: [],
    incompleteTasks: [],
    nextStep: [],
  };
}

function appendMapSource(target: Map<string, string[]>, key: string, source: string): void {
  const values = target.get(key) ?? [];
  pushUnique(values, source);
  target.set(key, values);
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

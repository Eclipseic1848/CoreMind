import { randomUUID } from "node:crypto";
import type { ArtifactRecord } from "coremind-tools";
import type { ExecutionEnvironment } from "coremind-tools/internal";
import type { AgentDriver } from "./agent-driver.js";
import type { ChildRunCoordinator } from "./child-run.js";
import type { BranchMessage } from "./compaction-projection.js";
import type { ControlInbox } from "./control-inbox.js";
import type { CallId, RunId, StepId, TurnId } from "./ids.js";
import type { LifecycleExtensionReceipt } from "./lifecycle-extension.js";
import type { CoreMindMessage } from "./public-message.js";
import { hasPendingJournalFlush, type RunStateJournal } from "./run-state.js";
import type { CoreMindSession } from "./session.js";

/** 单次 Run 的可变资源所有者；Runtime 门面只负责创建与切换实例。 */
export class RunContext<THarness> {
  private readonly agents = new Map<string, { name: string; driver: AgentDriver }>();
  private harnessFactory?: (agentName: string, stepId?: string, executionId?: string) => THarness;
  private journal?: RunStateJournal;
  private controlInbox?: ControlInbox;
  private session?: CoreMindSession;
  private branch?: BranchMessage[];
  private compactedPrefix?: number;
  private persistPaused = false;
  private readonly artifacts: ArtifactRecord[] = [];
  private readonly extensionReceipts: LifecycleExtensionReceipt[] = [];
  private executionEnvironment?: ExecutionEnvironment;
  private childRuns?: ChildRunCoordinator;
  private runId?: RunId;
  private readonly toolCalls = new Map<
    string,
    { agent: string; callId: CallId; turnId: TurnId; stepId?: StepId }
  >();
  private readonly delegationApprovalBindings = new Map<string, string>();
  private terminationError?: unknown;

  registerAgent(name: string, agent: AgentDriver, executionId = randomUUID()): void {
    this.agents.set(executionId, { name, driver: agent });
  }

  agent(name: string, executionId?: string): AgentDriver | undefined {
    if (executionId !== undefined) return this.agents.get(executionId)?.driver;
    const candidates = this.agentsNamed(name);
    const running = candidates.filter((driver) => driver.status().running);
    // 控制没有指定实例时，不把并行歧义静默路由到最后一个实例。
    return running.length > 1 ? undefined : (running[0] ?? candidates.at(-1));
  }

  agentsNamed(name: string): AgentDriver[] {
    return [...this.agents.values()]
      .filter((entry) => entry.name === name)
      .map((entry) => entry.driver);
  }

  abortAgents(): void {
    for (const { driver } of this.agents.values()) driver.abort();
  }

  collectMessages(): Map<string, CoreMindMessage[]> {
    const messages = new Map<string, CoreMindMessage[]>();
    for (const { name, driver } of this.agents.values()) {
      messages.set(name, [...(messages.get(name) ?? []), ...driver.messages()]);
    }
    return messages;
  }

  setHarnessFactory(
    factory?: (agentName: string, stepId?: string, executionId?: string) => THarness,
  ): void {
    this.harnessFactory = factory;
  }

  harnessFor(agentName: string, stepId?: string, executionId?: string): THarness | undefined {
    return this.harnessFactory?.(agentName, stepId, executionId);
  }

  attachJournal(journal?: RunStateJournal): void {
    this.journal = journal;
  }

  currentJournal(): RunStateJournal | undefined {
    return this.journal;
  }

  attachControlInbox(controlInbox?: ControlInbox): void {
    this.controlInbox = controlInbox;
  }

  currentControlInbox(): ControlInbox | undefined {
    return this.controlInbox;
  }

  attachChildRuns(childRuns?: ChildRunCoordinator): void {
    this.childRuns = childRuns;
  }

  currentChildRuns(): ChildRunCoordinator | undefined {
    return this.childRuns;
  }

  attachRunId(runId: RunId): void {
    this.runId = runId;
  }

  currentRunId(): RunId | undefined {
    return this.runId;
  }

  recordToolCall(input: { agent: string; callId: CallId; turnId: TurnId; stepId?: StepId }): void {
    this.toolCalls.set(`${agentCallKey(input.agent, input.callId)}\0${input.stepId ?? ""}`, input);
  }

  toolCall(
    agent: string,
    callId: CallId,
    stepId?: StepId,
  ): { agent: string; callId: CallId; turnId: TurnId; stepId?: StepId } | undefined {
    const calls = [...this.toolCalls.values()].filter(
      (call) =>
        call.agent === agent &&
        call.callId === callId &&
        (stepId === undefined || call.stepId === stepId),
    );
    return calls.length === 1 ? calls[0] : undefined;
  }

  recordDelegationApproval(agent: string, callId: CallId, inputFingerprint: string): void {
    this.delegationApprovalBindings.set(agentCallKey(agent, callId), inputFingerprint);
  }

  consumeDelegationApproval(agent: string, callId: CallId): string | undefined {
    const key = agentCallKey(agent, callId);
    const inputFingerprint = this.delegationApprovalBindings.get(key);
    this.delegationApprovalBindings.delete(key);
    return inputFingerprint;
  }

  async cancelChildRuns(reason: string): Promise<void> {
    await this.childRuns?.cancelAll(reason);
  }

  isQuiescent(): boolean {
    if (!this.isExecutionQuiescent()) return false;
    return this.childRuns === undefined || this.childRuns.isQuiescent();
  }

  isExecutionQuiescent(): boolean {
    for (const { driver } of this.agents.values()) {
      const status = driver.status();
      if (status.running || status.pendingToolCalls > 0 || status.queuedControls > 0) {
        return false;
      }
    }
    if (this.childRuns && !this.childRuns.isExecutionQuiescent()) return false;
    if (this.executionEnvironment && !this.executionEnvironment.isQuiescent()) return false;
    return this.journal === undefined || !hasPendingJournalFlush(this.journal);
  }

  attachExecutionEnvironment(environment: ExecutionEnvironment): void {
    this.executionEnvironment = environment;
    this.terminationError = undefined;
  }

  async terminateEnvironment(reason: string): Promise<void> {
    if (!this.executionEnvironment) return;
    try {
      await this.executionEnvironment.terminate(reason);
      this.terminationError = undefined;
    } catch (error) {
      this.terminationError = error;
      throw error;
    }
  }

  environmentTerminationError(): unknown {
    return this.terminationError;
  }

  attachSession(session: CoreMindSession, branch: BranchMessage[]): void {
    this.session = session;
    this.branch = branch;
  }

  sessionHandle(): CoreMindSession | undefined {
    return this.session;
  }

  sessionBranch(): BranchMessage[] | undefined {
    return this.branch;
  }

  replaceSessionBranch(branch: BranchMessage[]): void {
    this.branch = branch;
  }

  setCompactedPrefixEnd(end: number): void {
    this.compactedPrefix = end;
  }

  compactedPrefixEnd(): number | undefined {
    return this.compactedPrefix;
  }

  setSessionPersistPaused(paused: boolean): void {
    this.persistPaused = paused;
  }

  shouldTrimRejectedTrail(): boolean {
    return this.persistPaused;
  }

  recordArtifact(artifact: ArtifactRecord): void {
    this.artifacts.push(artifact);
  }

  artifactRecords(): ArtifactRecord[] {
    return this.artifacts;
  }

  recordExtension(receipt: LifecycleExtensionReceipt): void {
    this.extensionReceipts.push(receipt);
  }

  extensions(): LifecycleExtensionReceipt[] {
    return this.extensionReceipts;
  }
}

function agentCallKey(agent: string, callId: CallId): string {
  return `${agent}\0${callId}`;
}

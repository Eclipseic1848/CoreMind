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
  private readonly agents = new Map<string, AgentDriver>();
  private harnessFactory?: (agentName: string, stepId?: string) => THarness;
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

  registerAgent(name: string, agent: AgentDriver): void {
    this.agents.set(name, agent);
  }

  agent(name: string): AgentDriver | undefined {
    return this.agents.get(name);
  }

  abortAgents(): void {
    for (const agent of this.agents.values()) agent.abort();
  }

  collectMessages(): Map<string, CoreMindMessage[]> {
    return new Map([...this.agents].map(([name, agent]) => [name, agent.messages()]));
  }

  setHarnessFactory(factory?: (agentName: string, stepId?: string) => THarness): void {
    this.harnessFactory = factory;
  }

  harnessFor(agentName: string, stepId?: string): THarness | undefined {
    return this.harnessFactory?.(agentName, stepId);
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
    this.toolCalls.set(agentCallKey(input.agent, input.callId), input);
  }

  toolCall(
    agent: string,
    callId: CallId,
  ): { agent: string; callId: CallId; turnId: TurnId; stepId?: StepId } | undefined {
    return this.toolCalls.get(agentCallKey(agent, callId));
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
    for (const agent of this.agents.values()) {
      const status = agent.status();
      if (status.running || status.pendingToolCalls > 0 || status.queuedControls > 0) {
        return false;
      }
    }
    if (this.childRuns && !this.childRuns.isQuiescent()) return false;
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

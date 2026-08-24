import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ArtifactRecord } from "coremind-tools";
import type { BranchMessage } from "./compaction-projection.js";
import type { LifecycleExtensionReceipt } from "./lifecycle-extension.js";
import { hasPendingJournalFlush, type RunStateJournal } from "./run-state.js";
import type { CoreMindSession } from "./session.js";

/** 单次 Run 的可变资源所有者；Runtime 门面只负责创建与切换实例。 */
export class RunContext<THarness> {
  private readonly agents = new Map<string, Agent>();
  private harnessFactory?: (agentName: string, stepId?: string) => THarness;
  private journal?: RunStateJournal;
  private session?: CoreMindSession;
  private branch?: BranchMessage[];
  private compactedPrefix?: number;
  private persistPaused = false;
  private readonly artifacts: ArtifactRecord[] = [];
  private readonly extensionReceipts: LifecycleExtensionReceipt[] = [];

  registerAgent(name: string, agent: Agent): void {
    this.agents.set(name, agent);
  }

  agent(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  abortAgents(): void {
    for (const agent of this.agents.values()) agent.abort();
  }

  collectMessages(): Map<string, AgentMessage[]> {
    return new Map([...this.agents].map(([name, agent]) => [name, agent.state.messages]));
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

  isQuiescent(): boolean {
    for (const agent of this.agents.values()) {
      if (
        agent.state.isStreaming ||
        agent.state.pendingToolCalls.size > 0 ||
        agent.hasQueuedMessages()
      ) {
        return false;
      }
    }
    return this.journal === undefined || !hasPendingJournalFlush(this.journal);
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

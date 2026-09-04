import { createHash, randomUUID } from "node:crypto";
import {
  type ControlApplyResult,
  projectAppliedControlCommands,
  type RunControlCommand,
} from "./control-inbox.js";
import { CoreMindError } from "./errors.js";
import type { RunStateJournal, RunStateRecord } from "./run-state.js";

/** 候选正文只交给显式宿主接口；持久请求仅记录身份与内容摘要。 */
export interface HostVerificationRequest {
  schemaVersion: 1;
  runId: string;
  requestId: string;
  stepId: string;
  iteration: number;
  candidateSha256: string;
  candidate: string;
}

type RequestIdentity = Omit<HostVerificationRequest, "candidate">;
type VerificationCommand = Extract<RunControlCommand, { type: "verification" }>;
type Decision = Pick<VerificationCommand, "decision" | "feedback">;

interface GateOptions {
  runId: string;
  journal: RunStateJournal;
  records: readonly RunStateRecord[];
  timeoutMs: number;
  notify?: (request: HostVerificationRequest) => void;
  applyPending: () => Promise<unknown>;
}

/** 只拥有验收握手；执行、修正额度和终态仍由现有 Loop 与 Runtime 管理。 */
export class HostVerificationGate {
  private readonly requests = new Map<string, RequestIdentity>();
  private readonly decisions = new Map<string, Decision>();
  private pending?: {
    request: RequestIdentity;
    resolve: (decision: Decision) => void;
    reject: (error: CoreMindError) => void;
  };
  private interrupted?: CoreMindError;

  constructor(private readonly options: GateOptions) {
    const requestSequences = new Map<string, number>();
    for (const record of options.records) {
      if (record.kind !== "verification") continue;
      const request = record.payload as RequestIdentity;
      if (
        request?.schemaVersion !== 1 ||
        request.runId !== options.runId ||
        typeof request.requestId !== "string" ||
        !request.requestId ||
        typeof request.stepId !== "string" ||
        !request.stepId ||
        !Number.isInteger(request.iteration) ||
        request.iteration < 1 ||
        typeof request.candidateSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.candidateSha256) ||
        this.requests.has(request.stepId) ||
        requestSequences.has(request.requestId) ||
        request.stepId !== `loop-verify:${request.iteration}`
      )
        throw new CoreMindError("run_state_corrupt", "宿主验证请求事实无效或重复");
      this.requests.set(request.stepId, request);
      requestSequences.set(request.requestId, record.sequence);
    }
    for (const command of projectAppliedControlCommands(options.runId, options.records)) {
      if (command.type !== "verification") continue;
      const request = [...this.requests.values()].find(
        (item) => item.requestId === command.requestId,
      );
      const accepted = options.records.find(
        (record) =>
          record.kind === "control" &&
          (record.payload as { controlId?: string; state?: string }).controlId ===
            command.controlId &&
          (record.payload as { state?: string }).state === "accepted",
      );
      if (
        !request ||
        request.candidateSha256 !== command.candidateSha256 ||
        this.decisions.has(command.requestId) ||
        !accepted ||
        accepted.sequence <= requestSequences.get(command.requestId)!
      ) {
        throw new CoreMindError("run_state_corrupt", "宿主验证回复没有唯一匹配的请求");
      }
      this.decisions.set(command.requestId, {
        decision: command.decision,
        feedback: command.feedback,
      });
    }
  }

  get waiting(): boolean {
    return this.pending !== undefined;
  }

  async verify(input: { stepId: string; iteration: number; candidate: string }): Promise<Decision> {
    this.throwIfInterrupted();
    const candidateSha256 = createHash("sha256").update(input.candidate, "utf8").digest("hex");
    let request = this.requests.get(input.stepId);
    if (
      request &&
      (request.candidateSha256 !== candidateSha256 || request.iteration !== input.iteration)
    ) {
      throw new CoreMindError("loop_snapshot_mismatch", "恢复候选与原宿主验证对象不一致");
    }
    if (!request) {
      request = {
        schemaVersion: 1,
        runId: this.options.runId,
        requestId: randomUUID(),
        stepId: input.stepId,
        iteration: input.iteration,
        candidateSha256,
      };
      await this.options.journal.appendFact("verification", request, { durability: "critical" });
      this.requests.set(input.stepId, request);
    }
    this.throwIfInterrupted();
    const prior = this.decisions.get(request.requestId);
    if (prior) return { ...prior };
    const answer = new Promise<Decision>((resolve, reject) => {
      this.pending = { request, resolve, reject };
    });
    const pending = this.pending;
    // 在通知/应用持久控制期间也可能取消；提前接住拒绝，最终仍由 await 原样抛出。
    void answer.catch(() => undefined);
    const timer = setTimeout(
      () =>
        this.pending?.reject(
          new CoreMindError("loop_paused", "宿主验收超时，结果未知；未判定通过"),
        ),
      this.options.timeoutMs,
    );
    try {
      await this.options.applyPending();
      this.throwIfInterrupted();
      if (!this.decisions.has(request.requestId)) {
        if (!this.options.notify)
          throw new CoreMindError("loop_paused", "宿主验收接口不可用，未判定通过");
        // 返回值没有批准效力；只有 ControlInbox 稳定应用的回复能释放等待。
        void Promise.resolve(this.options.notify({ ...request, candidate: input.candidate })).catch(
          () => {
            if (this.pending === pending)
              pending?.reject(new CoreMindError("loop_paused", "宿主验收通知失败，结果未知"));
          },
        );
      }
      const decision = await answer;
      this.throwIfInterrupted();
      return decision;
    } catch (error) {
      if (error instanceof CoreMindError) throw error;
      throw new CoreMindError("loop_paused", "宿主验收接口不可用，结果未知");
    } finally {
      clearTimeout(timer);
      this.pending = undefined;
    }
  }

  apply(command: VerificationCommand): ControlApplyResult {
    const pending = this.pending;
    if (
      this.interrupted ||
      !pending ||
      command.runId !== this.options.runId ||
      command.requestId !== pending.request.requestId ||
      command.candidateSha256 !== pending.request.candidateSha256 ||
      this.decisions.has(command.requestId)
    )
      return { status: "rejected", reason: "宿主验收对象不匹配、已决定或当前不可接收回复" };
    const decision = { decision: command.decision, feedback: command.feedback };
    return {
      status: "applied",
      afterDurable: () => {
        this.decisions.set(command.requestId, decision);
        if (!this.interrupted) pending.resolve(decision);
      },
    };
  }

  interrupt(error: CoreMindError): void {
    this.interrupted ??= error;
    this.pending?.reject(this.interrupted);
  }

  private throwIfInterrupted(): void {
    if (this.interrupted) throw this.interrupted;
  }
}

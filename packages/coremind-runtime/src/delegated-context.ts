import type { ArtifactRecord } from "coremind-tools";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import { CoreMindError } from "./errors.js";
import type { RunStateRecord } from "./run-state.js";

export type ResolvedDelegatedContextReference =
  | {
      reference: string;
      type: "fact";
      eventId: string;
      sequence: number;
      factKind: RunStateRecord["kind"];
      timestamp: string;
      payloadFingerprint: string;
    }
  | {
      reference: string;
      type: "artifact";
      artifactId: string;
      sizeBytes: number;
      sha256: string;
      mediaType: string;
    };

/** 只解析当前父 Run 与受控 Artifact 集合中的显式引用，不复制原始正文。 */
export function resolveDelegatedContextReferences(input: {
  references: readonly string[];
  parentFacts: readonly RunStateRecord[];
  artifacts: readonly ArtifactRecord[];
  inheritedReferences?: readonly ResolvedDelegatedContextReference[];
}): ResolvedDelegatedContextReference[] {
  return [...new Set(input.references)].map((reference) => {
    const inherited = input.inheritedReferences?.find((item) => item.reference === reference);
    if (inherited) return structuredClone(inherited);
    const parsed = /^(fact|artifact):([^\s]+)$/u.exec(reference);
    if (!parsed) throw invalidReference(reference, "格式非法");
    const [, type, id] = parsed;
    if (type === "fact") {
      const fact = input.parentFacts.find((record) => record.eventId === id);
      if (!fact) throw invalidReference(reference, "不属于当前父 Run");
      return {
        reference,
        type,
        eventId: id!,
        sequence: fact.sequence,
        factKind: fact.kind,
        timestamp: fact.timestamp,
        payloadFingerprint: `sha256:${fingerprintEffectReceiptValue(fact.payload)}`,
      };
    }
    const artifact = input.artifacts.find((record) => record.artifactId === id);
    if (artifact?.status !== "stored" || artifact.redaction !== "none" || !artifact.sha256) {
      throw invalidReference(reference, "不属于当前父 Run 的可委派 Artifact");
    }
    return {
      reference,
      type: "artifact",
      artifactId: artifact.artifactId,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      mediaType: artifact.mediaType,
    };
  });
}

/** 构造 Child 唯一可见的任务输入；未知正文只留下不可逆指纹。 */
export function buildDelegatedInitialPrompt(
  task: string,
  resolvedReferences: readonly ResolvedDelegatedContextReference[],
): string {
  if (resolvedReferences.length === 0) return task;
  return [
    task,
    "",
    "CoreMind Delegated Context（仅限本次获准并已解析的显式引用）：",
    JSON.stringify(resolvedReferences),
  ].join("\n");
}

export function isResolvedDelegatedContextReference(
  value: unknown,
): value is ResolvedDelegatedContextReference {
  if (!isRecord(value) || typeof value.reference !== "string") return false;
  if (value.type === "fact") {
    return (
      typeof value.eventId === "string" &&
      typeof value.sequence === "number" &&
      Number.isSafeInteger(value.sequence) &&
      typeof value.factKind === "string" &&
      typeof value.timestamp === "string" &&
      typeof value.payloadFingerprint === "string"
    );
  }
  return (
    value.type === "artifact" &&
    typeof value.artifactId === "string" &&
    typeof value.sizeBytes === "number" &&
    Number.isFinite(value.sizeBytes) &&
    typeof value.sha256 === "string" &&
    typeof value.mediaType === "string"
  );
}

function invalidReference(reference: string, reason: string): CoreMindError {
  return new CoreMindError(
    "child_run_policy_escalation",
    `Delegated Context 引用 ${reference} ${reason}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

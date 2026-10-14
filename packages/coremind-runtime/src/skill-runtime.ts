import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentConfig, ToolEffectDeclaration } from "coremind-config";
import { findSkill } from "coremind-templates";
import type { StandardSkill } from "coremind-templates/internal";
import { resolveToolCapability } from "coremind-tools";
import type { AgentDriverObservation } from "./agent-driver.js";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindMessage } from "./public-message.js";
import type { RunStateRecord } from "./run-state.js";

export const SKILL_TOOL_NAME = "load_skill";
export const SKILL_TOOL_EFFECT: ToolEffectDeclaration = { operations: ["read"], reversible: true };
export const SKILL_TOOL_CAPABILITY = resolveToolCapability({
  tool: SKILL_TOOL_NAME,
  source: "registered",
  declaration: {
    effect: "none",
    replay: "safe",
    concurrency: "parallel",
    checkpoint: "none",
    durability: "ordinary",
  },
});
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface SkillSelection {
  legacyContents: string[];
  standard: StandardSkill[];
}

export interface SkillSnapshot {
  version: 1;
  agents: Record<string, SkillSelection>;
  sha256: string;
}

export interface SkillLoadFact {
  version: 1;
  id: string;
  bodySha256: string;
  snapshotSha256: string;
  delivery: "body" | "reference";
}

export function freezeSkillSnapshot(
  agents: Record<string, SkillSelection>,
): SkillSnapshot | undefined {
  if (!Object.values(agents).some((selection) => selection.standard.length > 0)) return undefined;
  const value = { version: 1 as const, agents: structuredClone(agents) };
  const snapshot = { ...value, sha256: fingerprintEffectReceiptValue(value) };
  assertSkillSnapshotSize(snapshot);
  return snapshot;
}

export function assertSkillSnapshotSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new CoreMindError("context_capability_conflict", "所选技能快照超过 2 MiB 上限");
  }
}

export function restoreSkillSnapshot(
  records: RunStateRecord[],
  agents: Record<string, AgentConfig>,
): SkillSnapshot | undefined {
  const start = records.find((record) => record.kind === "start");
  if (!isObject(start?.payload) || !Object.hasOwn(start.payload, "skillSnapshot")) {
    if (
      records.some(
        (record) =>
          record.kind === "event" &&
          isObject(record.payload) &&
          Object.hasOwn(record.payload, "skillLoad"),
      )
    ) {
      throw new CoreMindError("context_capability_conflict", "已有技能加载事实，但原冻结快照缺失");
    }
    return undefined;
  }
  const snapshot = start.payload.skillSnapshot;
  const invalid = () =>
    new CoreMindError("context_capability_conflict", "原技能快照损坏或选择不匹配");
  assertSkillSnapshotSize(snapshot);
  if (!isObject(snapshot) || snapshot.version !== 1 || !isObject(snapshot.agents)) throw invalid();
  if (Object.keys(snapshot.agents).length !== Object.keys(agents).length) throw invalid();
  for (const [agent, config] of Object.entries(agents)) {
    if (!Object.hasOwn(snapshot.agents, agent)) throw invalid();
    const selection = snapshot.agents[agent];
    if (
      !isObject(selection) ||
      !Array.isArray(selection.legacyContents) ||
      !selection.legacyContents.every((content) => typeof content === "string") ||
      !Array.isArray(selection.standard)
    )
      throw invalid();
    const seen = new Set<string>();
    for (const skill of selection.standard) {
      if (
        !isObject(skill) ||
        typeof skill.id !== "string" ||
        !(config.skills ?? []).includes(skill.id) ||
        findSkill(skill.id) !== undefined ||
        seen.has(skill.id) ||
        typeof skill.name !== "string" ||
        !skill.name.trim() ||
        typeof skill.description !== "string" ||
        !skill.description.trim() ||
        typeof skill.body !== "string" ||
        typeof skill.bodySha256 !== "string" ||
        createHash("sha256").update(skill.body, "utf8").digest("hex") !== skill.bodySha256
      )
        throw invalid();
      seen.add(skill.id);
    }
  }
  const { sha256, ...value } = snapshot;
  if (sha256 !== fingerprintEffectReceiptValue(value)) throw invalid();
  const frozen = snapshot as unknown as SkillSnapshot;
  if (!Object.values(frozen.agents).some((selection) => selection.standard.length > 0))
    throw invalid();
  return structuredClone(frozen);
}

export function skillPrefixContents(selection: SkillSelection): string[] {
  if (selection.standard.length === 0) return [...selection.legacyContents];
  const index = selection.standard
    .map(
      ({ id, name, description, bodySha256 }) =>
        `- ${JSON.stringify({ id, name, description, bodySha256 })}`,
    )
    .join("\n");
  return [
    ...selection.legacyContents,
    `## 可按需加载的标准技能\n仅索引不代表正文已加载；使用 load_skill({id}) 读取说明，不增加任何工具权限。\n${index}`,
  ];
}

export function renderSkillBody(skill: StandardSkill): string {
  return `# 技能 ${skill.id} · ${skill.name}\n正文 SHA-256: ${skill.bodySha256}\n\n${skill.body}`;
}

export function renderSkillReference(skill: StandardSkill): string {
  return `技能 ${skill.id} 已在当前上下文中（SHA-256: ${skill.bodySha256}），请复用已加载正文。`;
}

export function rebuildSkillResult(snapshot: SkillSnapshot, agent: string, fact: SkillLoadFact) {
  const skill = Object.hasOwn(snapshot.agents, agent)
    ? snapshot.agents[agent]!.standard.find((candidate) => candidate.id === fact.id)
    : undefined;
  if (
    !skill ||
    fact.version !== 1 ||
    fact.snapshotSha256 !== snapshot.sha256 ||
    fact.bodySha256 !== skill.bodySha256 ||
    !["body", "reference"].includes(fact.delivery)
  )
    throw new CoreMindError("context_capability_conflict", "技能加载事实与原快照不匹配");
  return {
    content: [
      {
        type: "text" as const,
        text: fact.delivery === "body" ? renderSkillBody(skill) : renderSkillReference(skill),
      },
    ],
    details: { id: skill.id, bodySha256: skill.bodySha256, delivery: fact.delivery },
  };
}

/** 每个 Agent 执行独占；只有真实成功结果及最终工作集能证明正文仍驻留。 */
export class SkillExecution {
  readonly tool: AgentTool;
  private readonly known = new Map<string, SkillLoadFact>();
  private readonly candidates = new Map<string, SkillLoadFact>();
  private readonly resident = new Set<string>();

  constructor(
    private readonly snapshot: SkillSnapshot,
    private readonly agent: string,
    records: RunStateRecord[] = [],
    stepId?: string,
  ) {
    for (const record of records) {
      if (
        record.kind !== "event" ||
        !isObject(record.payload) ||
        !Object.hasOwn(record.payload, "skillLoad")
      )
        continue;
      const event = record.payload.event;
      if (!isObject(event) || event.agent !== agent || event.stepId !== stepId) continue;
      const fact = record.payload.skillLoad;
      if (
        event.type !== "tool_result" ||
        event.tool !== SKILL_TOOL_NAME ||
        event.isError ||
        typeof event.callId !== "string" ||
        !isObject(fact)
      ) {
        throw new CoreMindError("context_capability_conflict", "技能加载事实的调用身份损坏");
      }
      rebuildSkillResult(snapshot, agent, fact as unknown as SkillLoadFact);
      this.known.set(event.callId, fact as unknown as SkillLoadFact);
    }
    const skills = snapshot.agents[agent]!.standard;
    this.tool = {
      name: SKILL_TOOL_NAME,
      label: "加载技能",
      description: "按已配置的 ID 加载本轮冻结的专业说明；不执行脚本或增加权限。",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: { id: { type: "string", enum: skills.map((skill) => skill.id) } },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (callId, args, signal) => {
        signal?.throwIfAborted();
        if (!isObject(args) || Object.keys(args).length !== 1 || typeof args.id !== "string") {
          throw new CoreMindError("invalid_tool", "加载技能只接受一个已授权 id");
        }
        const skill = skills.find((candidate) => candidate.id === args.id);
        if (!skill) throw new CoreMindError("invalid_tool", "该技能不在当前 Agent 的选择中");
        const fact: SkillLoadFact = {
          version: 1,
          id: skill.id,
          bodySha256: skill.bodySha256,
          snapshotSha256: snapshot.sha256,
          delivery: this.resident.has(skill.id) ? "reference" : "body",
        };
        this.candidates.set(callId, fact);
        return rebuildSkillResult(snapshot, agent, fact);
      },
    };
  }

  observe(observation: AgentDriverObservation): SkillLoadFact | undefined {
    if (observation.type !== "tool_execution_end") return undefined;
    const fact = this.candidates.get(observation.call.callId);
    this.candidates.delete(observation.call.callId);
    if (
      !fact ||
      observation.isError ||
      observation.call.tool !== SKILL_TOOL_NAME ||
      !isObject(observation.call.args) ||
      observation.call.args.id !== fact.id ||
      JSON.stringify(observation.result.content) !==
        JSON.stringify(rebuildSkillResult(this.snapshot, this.agent, fact).content) ||
      JSON.stringify(observation.result.details) !==
        JSON.stringify(rebuildSkillResult(this.snapshot, this.agent, fact).details)
    )
      return undefined;
    this.known.set(observation.call.callId, fact);
    if (fact.delivery === "body") this.resident.add(fact.id);
    return fact;
  }

  refresh(messages: CoreMindMessage[]): void {
    this.resident.clear();
    for (const message of messages) {
      const result = message as CoreMindMessage & {
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
      };
      const fact = result.toolCallId ? this.known.get(result.toolCallId) : undefined;
      if (
        fact?.delivery !== "body" ||
        result.role !== "toolResult" ||
        result.isError ||
        result.toolName !== SKILL_TOOL_NAME
      )
        continue;
      const expected = rebuildSkillResult(this.snapshot, this.agent, fact);
      if (JSON.stringify(result.content) === JSON.stringify(expected.content))
        this.resident.add(fact.id);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ProtocolEventNotificationSchema, ProtocolV2EventEnvelopeSchema } from "./index.js";

const required = {
  type: "approval_required",
  approvalId: "approval-1",
  runId: "run-1",
  agent: "main",
  tool: "read",
  args: { path: "notes.txt" },
  argumentsFingerprint: "a".repeat(64),
  risk: "low",
  effect: {
    operations: ["read"],
    paths: ["notes.txt"],
    urls: [],
    reversible: true,
    declared: true,
  },
};
const envelope = {
  protocolVersion: "2.0",
  eventSchemaVersion: 1,
  runId: "run-1",
  sequence: 1,
  eventId: "event-approval",
  timestamp: "2026-10-15T00:00:00.000Z",
  ignorable: false,
  sensitivity: "local",
};

describe("审批请求只追加可选工具调用身份", () => {
  it("v2 旧 required 省略字段不变，新增 callId/stepId 与原指纹共同保留", () => {
    const legacy = { ...envelope, eventType: "approval_required", payload: required };
    const original = JSON.stringify(legacy);
    expect(Value.Check(ProtocolV2EventEnvelopeSchema, legacy)).toBe(true);
    expect(JSON.stringify(legacy)).toBe(original);
    for (const identity of [{ callId: "call-1" }, { callId: "call-1", stepId: "step-a" }]) {
      expect(
        Value.Check(ProtocolV2EventEnvelopeSchema, {
          ...legacy,
          ...identity,
          payload: { ...required, ...identity },
        }),
      ).toBe(true);
    }
  });

  it.each([
    { callId: 1 },
    { callId: null },
    { callId: "" },
    { stepId: 1 },
    { stepId: null },
    { stepId: "" },
    { callId: "call-1", unknown: true },
  ])("v2 拒绝错误身份类型或额外字段 %j", (identity) => {
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        eventType: "approval_required",
        payload: { ...required, ...identity },
      }),
    ).toBe(false);
  });

  it("resolved 保持原合同，仅按 runId/approvalId 回连，不新增身份字段", () => {
    const payload = {
      type: "approval_resolved",
      runId: "run-1",
      approvalId: "approval-1",
      decision: "allow",
    };
    const value = { ...envelope, eventType: "approval_resolved", payload };
    expect(Value.Check(ProtocolV2EventEnvelopeSchema, value)).toBe(true);
    for (const field of ["callId", "stepId", "agent"])
      expect(
        Value.Check(ProtocolV2EventEnvelopeSchema, {
          ...value,
          payload: { ...payload, [field]: "unexpected" },
        }),
      ).toBe(false);
  });

  it("v1 事件仍为原开放 payload，无身份旧包和有身份新包均可传输", () => {
    for (const event of [required, { ...required, callId: "call-1", stepId: "step-a" }]) {
      const packet = {
        jsonrpc: "2.0",
        method: "event",
        params: {
          protocolVersion: "1.0",
          runId: "run-1",
          sequence: 1,
          timestamp: "2026-10-15T00:00:00.000Z",
          event,
        },
      };
      expect(Value.Check(ProtocolEventNotificationSchema, packet)).toBe(true);
    }
  });
});

describe("Artifact 仅追加可选来源身份", () => {
  const artifact = {
    type: "artifact_created",
    artifactId: "artifact-1",
    status: "stored",
    sizeBytes: 32768,
    relativePath: ".coremind/artifacts/artifact-1.log",
    sha256: "b".repeat(64),
    mediaType: "text/plain; charset=utf-8",
    redaction: "none",
    tool: "read",
    callId: "same-call",
  };

  it("旧包省略 agent/stepId 保持原形状", () => {
    const value = { ...envelope, eventType: "artifact_created", payload: artifact };
    const original = JSON.stringify(value);
    expect(Value.Check(ProtocolV2EventEnvelopeSchema, value)).toBe(true);
    expect(JSON.stringify(value)).toBe(original);
    expect(Object.hasOwn(value.payload, "agent")).toBe(false);
    expect(Object.hasOwn(value.payload, "stepId")).toBe(false);
  });

  it("新包保留真实 agent 与可选 stepId，不按 callId 猜来源", () => {
    for (const identity of [
      { agent: "main" },
      { stepId: "step-a" },
      { agent: "main", stepId: "step-a" },
    ]) {
      expect(
        Value.Check(ProtocolV2EventEnvelopeSchema, {
          ...envelope,
          eventType: "artifact_created",
          payload: { ...artifact, ...identity },
        }),
      ).toBe(true);
    }
  });

  it.each([
    { agent: 1 },
    { agent: null },
    { stepId: 1 },
    { stepId: null },
    { stepId: "" },
    { agent: "main", unknown: true },
  ])("拒绝错误来源类型和额外字段 %j", (identity) => {
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        eventType: "artifact_created",
        payload: { ...artifact, ...identity },
      }),
    ).toBe(false);
  });
});

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ProtocolV2EventEnvelopeSchema } from "./index.js";

const summary = {
  version: 1,
  catalogFingerprint: "catalog-fingerprint",
  generation: 0,
  selectionFingerprint: "selection-fingerprint",
  toolCount: 1,
};
const envelope = {
  protocolVersion: "2.0",
  eventSchemaVersion: 1,
  eventType: "context_prefix",
  runId: "run-discovery",
  sequence: 1,
  eventId: "prefix-1",
  timestamp: "2026-10-14T00:00:00.000Z",
  ignorable: false,
  sensitivity: "local",
  payload: { type: "context_prefix", agent: "main", fingerprint: "prefix-fingerprint" },
};

describe("工具发现只扩展 context_prefix 安全摘要", () => {
  it("provider_request 引用相同安全摘要并保留原请求指纹", () => {
    const payload = {
      type: "provider_request",
      requestId: "request-discovery",
      agent: "main",
      providerId: "fixture",
      modelId: "fixture",
      messageFingerprint: "message",
      stablePrefixFingerprint: "prefix",
      toolSchemaFingerprint: "schema",
      capabilityFingerprint: "capability",
      contextWorkingSetFingerprint: "working-set",
    };
    const request = { ...envelope, eventType: "provider_request", payload };
    expect(Value.Check(ProtocolV2EventEnvelopeSchema, request)).toBe(true);
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...request,
        payload: { ...payload, toolDiscovery: summary },
      }),
    ).toBe(true);
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...request,
        payload: { ...payload, toolDiscovery: { ...summary, schema: "private" } },
      }),
    ).toBe(false);
    const { toolSchemaFingerprint: _fingerprint, ...missingFingerprint } = payload;
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...request,
        payload: { ...missingFingerprint, toolDiscovery: summary },
      }),
    ).toBe(false);
  });

  it("旧事件省略摘要不变，新事件接受封闭的五字段摘要", () => {
    expect(Value.Check(ProtocolV2EventEnvelopeSchema, envelope)).toBe(true);
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        payload: { ...envelope.payload, toolDiscovery: summary },
      }),
    ).toBe(true);
  });

  it.each(
    [
      { ...summary, version: 2 },
      { ...summary, generation: -1 },
      { ...summary, generation: 0.5 },
      { ...summary, toolCount: -1 },
      { ...summary, toolCount: true },
      { ...summary, catalogFingerprint: 1 },
      { ...summary, selectionFingerprint: null },
      { ...summary, tools: [{ name: "不应公开的目录" }] },
      { ...summary, schema: { private: "不应公开的参数" } },
      null,
    ].map((toolDiscovery) => ({ toolDiscovery })),
  )("拒绝非法或泄露目录的摘要 $toolDiscovery", ({ toolDiscovery }) => {
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        payload: { ...envelope.payload, toolDiscovery },
      }),
    ).toBe(false);
  });
});

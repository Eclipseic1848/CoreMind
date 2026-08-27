import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  negotiateProtocolV2,
  PROTOCOL_V2_SCHEMA_BUNDLE,
  PROTOCOL_V2_SCHEMA_FINGERPRINT,
  PROTOCOL_V2_VERSION,
  ProtocolV2ErrorResponseSchema,
  ProtocolV2EventEnvelopeSchema,
  parseProtocolV2Request,
} from "./index.js";

describe("CoreMind Protocol v2", () => {
  it("schema fingerprint 覆盖请求、响应、事件与错误合同", () => {
    expect(Object.keys(PROTOCOL_V2_SCHEMA_BUNDLE)).toEqual([
      "request",
      "initializeResult",
      "runHandle",
      "eventEnvelope",
      "eventPage",
      "queryResult",
      "controlReceipt",
      "errorResponse",
    ]);
    expect(PROTOCOL_V2_SCHEMA_FINGERPRINT).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(PROTOCOL_V2_SCHEMA_BUNDLE.errorResponse)).toContain(
      '"unclassified_error"',
    );
    expect(
      Value.Check(ProtocolV2ErrorResponseSchema, {
        jsonrpc: "2.0",
        id: "run-1",
        error: {
          code: -32_000,
          message: "需要人工处置",
          data: { coremindCode: "unclassified_error" },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(ProtocolV2ErrorResponseSchema, {
        jsonrpc: "2.0",
        id: "run-1",
        error: {
          code: -32_000,
          message: "私有错误",
          data: { coremindCode: "vendor_private_error" },
        },
      }),
    ).toBe(false);
  });

  it("事件 schema 以 eventType 判别并校验已知 payload 字段", () => {
    const envelope = {
      protocolVersion: "2.0",
      eventSchemaVersion: 1,
      runId: "run-1",
      sequence: 1,
      eventId: "event-1",
      timestamp: "2026-08-25T00:00:00.000Z",
      ignorable: false,
      sensitivity: "local",
    } as const;

    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        eventType: "text_delta",
        payload: { type: "text_delta", agent: "main", delta: "片段" },
      }),
    ).toBe(true);
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        eventType: "text_delta",
        payload: { type: "text_delta", agent: "main" },
      }),
    ).toBe(false);
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        eventType: "text_delta",
        payload: { type: "agent_start", agent: "main" },
      }),
    ).toBe(false);
    expect(JSON.stringify(ProtocolV2EventEnvelopeSchema)).toContain('"delta"');
  });

  it("Protocol v2 事件 envelope 显式携带父子 Run 与 Delegation 身份", () => {
    expect(JSON.stringify(ProtocolV2EventEnvelopeSchema)).toContain('"parentRunId"');
    expect(JSON.stringify(ProtocolV2EventEnvelopeSchema)).toContain('"delegationId"');
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        protocolVersion: "2.0",
        eventSchemaVersion: 1,
        eventType: "fact.delegation",
        runId: "run-parent",
        parentRunId: "run-parent",
        childRunId: "run-child",
        delegationId: "delegation-review",
        sequence: 1,
        eventId: "event-delegation",
        timestamp: "2026-08-27T00:00:00.000Z",
        payload: { type: "child_created" },
        ignorable: false,
        sensitivity: "local",
      }),
    ).toBe(true);
  });

  it("解析显式版本范围与客户端能力的 initialize 请求", () => {
    const request = parseProtocolV2Request({
      jsonrpc: "2.0",
      id: "init-v2",
      method: "initialize",
      params: {
        protocolRange: {
          minVersion: PROTOCOL_V2_VERSION,
          maxVersion: PROTOCOL_V2_VERSION,
        },
        capabilities: ["typedEvents", "controlInbox", "projectionQuery"],
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });

    expect(request).toEqual({
      jsonrpc: "2.0",
      id: "init-v2",
      method: "initialize",
      params: {
        protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
        capabilities: ["typedEvents", "controlInbox", "projectionQuery"],
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });
  });

  it("版本范围与 Host 无交集时失败关闭", () => {
    expect(() => negotiateProtocolV2({ minVersion: "3.0", maxVersion: "3.9" })).toThrowError(
      expect.objectContaining({
        code: "protocol_version_unsupported",
        message: "Protocol v2 Host 不支持客户端版本范围 3.0～3.9",
      }),
    );
  });

  it("解析持久事件游标续读与 Projection 查询请求", () => {
    expect(
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "events-1",
        method: "events",
        params: { runId: "run-1", afterSequence: 7, limit: 50 },
      }),
    ).toMatchObject({ method: "events", params: { afterSequence: 7, limit: 50 } });
    expect(
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "query-1",
        method: "query",
        params: { runId: "run-1" },
      }),
    ).toMatchObject({ method: "query", params: { runId: "run-1" } });
  });

  it("解析带稳定 RunId 的 chat 与 resume 启动请求", () => {
    expect(
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "chat-1",
        method: "chat",
        params: { runId: "chat-run", agent: "main", message: "继续讨论" },
      }),
    ).toMatchObject({ method: "chat", params: { runId: "chat-run", message: "继续讨论" } });
    expect(
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "resume-1",
        method: "resume",
        params: { runId: "paused-run", input: "继续执行" },
      }),
    ).toMatchObject({ method: "resume", params: { runId: "paused-run" } });
  });
});

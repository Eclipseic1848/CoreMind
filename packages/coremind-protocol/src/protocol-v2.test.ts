import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  negotiateProtocolV2,
  PROTOCOL_V2_SCHEMA_BUNDLE,
  PROTOCOL_V2_SCHEMA_FINGERPRINT,
  PROTOCOL_V2_VERSION,
  ProtocolV2CheckpointResultSchema,
  ProtocolV2ErrorResponseSchema,
  ProtocolV2EventEnvelopeSchema,
  ProtocolV2RunHandleSchema,
  ProtocolV2ToolCallNotificationSchema,
  ProtocolV2ToolCancelNotificationSchema,
  ProtocolV2ToolRegistrationReceiptSchema,
  ProtocolV2ToolResultReceiptSchema,
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
      "checkpointResult",
      "toolCallNotification",
      "toolCancelNotification",
      "toolRegistrationReceipt",
      "toolResultReceipt",
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

  it("审批事件可携带绑定参数的 SHA-256 指纹", () => {
    const envelope = {
      protocolVersion: "2.0",
      eventSchemaVersion: 1,
      runId: "run-1",
      sequence: 1,
      eventId: "event-approval",
      timestamp: "2026-08-28T00:00:00.000Z",
      ignorable: false,
      sensitivity: "local",
    } as const;
    const argumentsFingerprint = "a".repeat(64);
    const delegationInputFingerprint = `sha256:${"b".repeat(64)}`;

    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        eventType: "approval_required",
        payload: {
          type: "approval_required",
          approvalId: "approval-1",
          runId: "run-1",
          agent: "main",
          tool: "delegate",
          args: { target: "researcher", task: "核验资料" },
          argumentsFingerprint,
          delegationInputFingerprint,
          risk: "high",
          effect: {
            operations: ["read"],
            paths: [],
            urls: [],
            reversible: true,
            declared: true,
          },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        eventType: "approval_resolved",
        payload: {
          type: "approval_resolved",
          approvalId: "approval-1",
          runId: "run-1",
          decision: "allow",
          argumentsFingerprint,
          delegationInputFingerprint,
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        eventType: "approval_resolved",
        payload: {
          type: "approval_resolved",
          approvalId: "approval-1",
          runId: "run-1",
          decision: "allow",
          argumentsFingerprint: "not-a-sha256",
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(ProtocolV2EventEnvelopeSchema, {
        ...envelope,
        eventType: "approval_resolved",
        payload: {
          type: "approval_resolved",
          approvalId: "approval-1",
          runId: "run-1",
          decision: "allow",
          argumentsFingerprint,
          delegationInputFingerprint: "b".repeat(64),
        },
      }),
    ).toBe(false);
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

  it("在协议边界拒绝空白与控制字符 Branded ID", () => {
    expect(() =>
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "run-invalid",
        method: "run",
        params: { runId: " \t" },
      }),
    ).toThrowError(/无效的 CoreMind Protocol v2 请求/);
    expect(() =>
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "checkpoint-invalid",
        method: "checkpoint",
        params: {
          schemaVersion: 1,
          action: "create",
          operationId: "operation\ninvalid",
          runId: "run-1",
          path: "result.txt",
        },
      }),
    ).toThrowError(/无效的 CoreMind Protocol v2 请求/);
    expect(() =>
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "tool-result-invalid",
        method: "tool_result",
        params: {
          schemaVersion: 1,
          resultId: "result-1",
          runId: "run-1",
          callId: "call\0invalid",
          registrationId: "registration-1",
          result: null,
        },
      }),
    ).toThrowError(/无效的 CoreMind Protocol v2 请求/);
  });

  it("解析带身份、版本与显式恢复预期的 Checkpoint 操作", () => {
    expect(
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "checkpoint-create-1",
        method: "checkpoint",
        params: {
          schemaVersion: 1,
          action: "create",
          operationId: "checkpoint-operation-1",
          runId: "run-1",
          path: "result.txt",
        },
      }),
    ).toMatchObject({ method: "checkpoint", params: { action: "create" } });
    expect(
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "checkpoint-restore-1",
        method: "checkpoint",
        params: {
          schemaVersion: 1,
          action: "restore",
          operationId: "checkpoint-operation-2",
          runId: "run-1",
          checkpointId: "checkpoint-1",
          checkpointVersion: 1,
          confirm: true,
          expectedCurrent: { existed: true, sha256: "a".repeat(64) },
        },
      }),
    ).toMatchObject({ method: "checkpoint", params: { action: "restore", confirm: true } });
    expect(() =>
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "checkpoint-restore-unconfirmed",
        method: "checkpoint",
        params: {
          schemaVersion: 1,
          action: "restore",
          operationId: "checkpoint-operation-3",
          runId: "run-1",
          checkpointId: "checkpoint-1",
          checkpointVersion: 1,
          confirm: false,
          expectedCurrent: { existed: false, sha256: "a".repeat(64) },
        },
      }),
    ).toThrowError(/无效的 CoreMind Protocol v2 请求/);
    expect(
      Value.Check(ProtocolV2CheckpointResultSchema, {
        schemaVersion: 1,
        action: "list",
        runId: "run-1",
        derivedFromSequence: 7,
        checkpoints: [
          {
            checkpointVersion: 1,
            checkpointId: "checkpoint-1",
            runId: "run-1",
            createdAt: "2026-08-30T00:00:00.000Z",
            reversible: true,
            path: "result.txt",
            before: { existed: true, sha256: "a".repeat(64) },
          },
        ],
      }),
    ).toBe(true);
    expect(JSON.stringify(ProtocolV2CheckpointResultSchema)).not.toMatch(
      /snapshotFile|unifiedDiff/,
    );
    expect(
      Value.Check(ProtocolV2CheckpointResultSchema, {
        schemaVersion: 1,
        action: "diff",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        checkpointVersion: 1,
        changed: false,
        reversible: true,
      }),
    ).toBe(false);
  });

  it("解析声明式动态工具与绑定完整身份的结果桥", () => {
    expect(
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "tool-register-1",
        method: "tool_register",
        params: {
          schemaVersion: 1,
          registrationId: "registration-1",
          definitionVersion: 1,
          toolId: "lookup-record",
          name: "lookup_record",
          description: "读取一条记录",
          parameters: { type: "object", properties: { id: { type: "string" } } },
          effect: { operations: ["read"], reversible: true },
          capability: {
            effect: "none",
            replay: "safe",
            concurrency: "parallel",
            checkpoint: "none",
            durability: "ordinary",
          },
        },
      }),
    ).toMatchObject({ method: "tool_register", params: { registrationId: "registration-1" } });
    expect(
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "tool-result-1",
        method: "tool_result",
        params: {
          schemaVersion: 1,
          resultId: "result-1",
          runId: "run-1",
          callId: "call-1",
          registrationId: "registration-1",
          result: { value: 42 },
        },
      }),
    ).toMatchObject({ method: "tool_result", params: { resultId: "result-1" } });
    expect(
      Value.Check(ProtocolV2ToolCallNotificationSchema, {
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        method: "tool_call",
        params: {
          schemaVersion: 1,
          runId: "run-1",
          callId: "call-1",
          registrationId: "registration-1",
          toolId: "lookup-record",
          name: "lookup_record",
          argumentsFingerprint: `sha256:${"b".repeat(64)}`,
          args: { id: "42" },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(ProtocolV2ToolCancelNotificationSchema, {
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        method: "tool_cancel",
        params: {
          schemaVersion: 1,
          runId: "run-1",
          callId: "call-1",
          registrationId: "registration-1",
          toolId: "lookup-record",
          reason: "aborted",
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(ProtocolV2ToolRegistrationReceiptSchema, {
        schemaVersion: 1,
        registrationId: "registration-1",
        toolId: "lookup-record",
        definitionFingerprint: `sha256:${"c".repeat(64)}`,
        status: "registered",
      }),
    ).toBe(true);
    expect(
      Value.Check(ProtocolV2ToolResultReceiptSchema, {
        schemaVersion: 1,
        resultId: "result-1",
        runId: "run-1",
        callId: "call-1",
        registrationId: "registration-1",
        status: "duplicate",
      }),
    ).toBe(true);
  });

  it("解析 Delegation Disposition 控制并在 RunHandle 中公开该能力", () => {
    expect(
      parseProtocolV2Request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "disposition-1",
        method: "control",
        params: {
          schemaVersion: 1,
          controlId: "disposition-control-1",
          runId: "run-parent",
          type: "delegation_disposition",
          delegationId: "delegation-failed-1",
          action: "choose_alternative",
          reason: "人工选择替代方案",
        },
      }),
    ).toMatchObject({
      method: "control",
      params: {
        type: "delegation_disposition",
        delegationId: "delegation-failed-1",
        action: "choose_alternative",
      },
    });
    expect(
      Value.Check(ProtocolV2RunHandleSchema, {
        runId: "run-parent",
        acceptedAt: "2026-08-29T00:00:00.000Z",
        initialCursor: 0,
        selectedProtocol: "2.0",
        availableControls: [
          "cancel",
          "approval",
          "steering",
          "follow_up",
          "delegation_disposition",
        ],
      }),
    ).toBe(true);
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

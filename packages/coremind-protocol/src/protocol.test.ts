import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  createErrorResponse,
  createEventNotification,
  createSuccessResponse,
  PROTOCOL_VERSION,
  parseProtocolRequest,
  parseRunSnapshot,
  RunSnapshotSchema,
} from "./index.js";

describe("CoreMind Protocol v1", () => {
  it("校验跨入口共享的运行快照信封", () => {
    const snapshot = {
      schemaVersion: 1,
      runId: "run-1",
      operation: {
        schemaVersion: 1,
        operationId: "operation-1",
        runId: "run-1",
        correlationId: "run-1:operation-1",
        state: "completed",
        transitionSequence: 3,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:01.000Z",
      },
      outcome: { status: "succeeded", finishReason: "completed" },
      metrics: {
        durationMs: 1000,
        turns: 1,
        steps: { total: 1, succeeded: 1, failed: 0 },
        toolCalls: 0,
        toolFailures: 0,
        retries: 0,
        outputChars: 12,
      },
      evaluation: {
        profile: "strict",
        scenarioResults: [],
        qualityScores: { execution: 1 },
        securityFindings: [],
      },
      releaseReadiness: { ready: true, blockers: [], warnings: [] },
      trace: [],
      checkpoints: [],
      artifacts: [],
      extensions: [],
      resumable: false,
    };
    expect(Value.Check(RunSnapshotSchema, snapshot)).toBe(true);
    expect(parseRunSnapshot(snapshot).runId).toBe("run-1");
    const snapshotWithDetailedTrace = {
      ...snapshot,
      trace: [
        {
          eventId: "event-1",
          runId: "run-1",
          sequence: 1,
          timestamp: "2026-08-12T00:00:00.000Z",
          event: { type: "context_prefix", agent: "main", fingerprint: "sha256:test" },
        },
      ],
    };
    expect(parseRunSnapshot(snapshotWithDetailedTrace).trace).toEqual(
      snapshotWithDetailedTrace.trace,
    );
    expect(() => parseRunSnapshot({ ...snapshot, resumable: "no" })).toThrow("RunSnapshot");
    expect(() =>
      parseRunSnapshot({
        ...snapshot,
        operation: { ...snapshot.operation, state: "teleported" },
      }),
    ).toThrow("/operation/state");
    expect(() =>
      parseRunSnapshot({
        ...snapshot,
        metrics: { ...snapshot.metrics, steps: { total: "1", succeeded: 1, failed: 0 } },
      }),
    ).toThrow("/metrics/steps/total");
  });

  it("解析合法的 initialize 请求", () => {
    const request = parseProtocolRequest({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });

    expect(request).toMatchObject({
      id: "init-1",
      method: "initialize",
      params: { protocolVersion: "1.0", configDir: "." },
    });
  });

  it("解析运行、对话、取消、审批和关闭请求", () => {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "run", params: { input: "执行任务" } },
      { jsonrpc: "2.0", id: 2, method: "chat", params: { agent: "main", message: "你好" } },
      { jsonrpc: "2.0", id: 3, method: "cancel", params: { runId: "run-1" } },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "approve",
        params: { runId: "run-1", approvalId: "approval-1", decision: "allow" },
      },
      { jsonrpc: "2.0", id: 5, method: "close", params: {} },
    ];

    expect(requests.map((request) => parseProtocolRequest(request).method)).toEqual([
      "run",
      "chat",
      "cancel",
      "approve",
      "close",
    ]);
  });

  it("创建稳定的成功、错误和事件消息", () => {
    expect(createSuccessResponse("run-1", { status: "succeeded" })).toEqual({
      jsonrpc: "2.0",
      id: "run-1",
      result: { status: "succeeded" },
    });
    expect(createErrorResponse("run-1", -32_000, "执行失败", "agent_failed")).toEqual({
      jsonrpc: "2.0",
      id: "run-1",
      error: { code: -32_000, message: "执行失败", data: { coremindCode: "agent_failed" } },
    });
    expect(
      createEventNotification({
        runId: "run-1",
        sequence: 1,
        timestamp: "2026-08-07T00:00:00.000Z",
        event: { type: "agent_start", agent: "main" },
      }),
    ).toMatchObject({
      jsonrpc: "2.0",
      method: "event",
      params: { protocolVersion: "1.0", runId: "run-1", sequence: 1 },
    });
  });

  it("支持 Python callable 注册和工具结果回传", () => {
    expect(
      parseProtocolRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "register_tool",
        params: {
          name: "lookup_order",
          description: "查询订单",
          parameters: {
            type: "object",
            properties: { orderId: { type: "string" } },
            required: ["orderId"],
          },
          effect: { operations: ["read"], reversible: true },
        },
      }),
    ).toMatchObject({ method: "register_tool" });

    expect(
      parseProtocolRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tool_result",
        params: { callId: "call-1", result: { status: "paid" } },
      }),
    ).toMatchObject({ method: "tool_result" });
  });

  it("initialize 可由 Node worker 直接加载配置文件", () => {
    expect(
      parseProtocolRequest({
        jsonrpc: "2.0",
        id: "init-file",
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, configPath: "coremind.yaml" },
      }),
    ).toMatchObject({ method: "initialize", params: { configPath: "coremind.yaml" } });
  });

  it("initialize 接受显式 Loop 配置而不暴露控制器实现", () => {
    const request = parseProtocolRequest({
      jsonrpc: "2.0",
      id: "init-loop",
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: {
          schemaVersion: 2,
          name: "loop-demo",
          agents: { worker: {}, reviewer: {} },
          loop: {
            execute: { agent: "worker", input: "执行 {{prompt}}" },
            verify: {
              agent: "reviewer",
              input: "验证 {{candidate.text}}",
              passIf: "{{text}} contains PASS",
            },
            repair: { agent: "worker", input: "修复" },
          },
        },
        configDir: ".",
      },
    });

    expect(request).toMatchObject({ method: "initialize", params: { config: { loop: {} } } });
    expect(JSON.stringify(request)).not.toContain("xstate");
  });

  it("覆盖 RunState 检查与 checkpoint diff/显式恢复", () => {
    const requests = [
      { jsonrpc: "2.0", id: 6, method: "inspect_run", params: { runId: "run-1" } },
      {
        jsonrpc: "2.0",
        id: 9,
        method: "resume_run",
        params: { runId: "run-1", input: "原始输入" },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "checkpoint_diff",
        params: { runId: "run-1", checkpointId: "checkpoint-1" },
      },
      {
        jsonrpc: "2.0",
        id: 8,
        method: "checkpoint_restore",
        params: { runId: "run-1", checkpointId: "checkpoint-1", confirm: true },
      },
    ];

    expect(requests.map((request) => parseProtocolRequest(request).method)).toEqual([
      "inspect_run",
      "resume_run",
      "checkpoint_diff",
      "checkpoint_restore",
    ]);
  });
});

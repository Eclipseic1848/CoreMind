import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_V2_SCHEMA_FINGERPRINT,
  ProtocolV2SessionClient,
  parseProtocolV2Request,
  parseProtocolV2SessionResult,
  parseProtocolV2TaskResult,
} from "./index.js";

const params = {
  action: "start",
  sessionId: "bound",
  taskId: "job",
  type: "demo",
  checkpoint: 0,
} as const;
const request = { jsonrpc: "2.0", protocolVersion: "2.0", id: 1, method: "task", params };
const task = {
  taskId: "job",
  type: "demo",
  version: 1,
  phase: "a",
  checkpoint: 0,
  status: "ready",
};
const result = { schemaVersion: 1, sessionId: "bound", action: "start", taskId: "job", task };
const initialized = {
  selectedProtocol: "2.0",
  runtime: "node",
  warnings: [],
  serverCapabilities: ["durableTasks", "sessionBranches"],
  schemaFingerprint: PROTOCOL_V2_SCHEMA_FINGERPRINT,
  migration: { v1Supported: true, v1SupportedThrough: "0.4.x", earliestRemoval: "0.5.0" },
} as const;

describe("跨语言任务和会话合同", () => {
  it("任务入口仅接受既定字段，不能提交代码、模块或环境变量", () => {
    expect(parseProtocolV2Request(request)).toEqual(request);
    for (const field of ["modulePath", "source", "definitions", "env", "credentials"])
      expect(() =>
        parseProtocolV2Request({ ...request, params: { ...params, [field]: "secret" } }),
      ).toThrow();
    expect(() =>
      parseProtocolV2Request({ ...request, params: { ...params, sessionId: "../other" } }),
    ).toThrow();
  });

  it("任务响应同时核对会话、操作和内外任务身份", () => {
    expect(parseProtocolV2TaskResult(result, params)).toEqual(result);
    for (const change of [
      { sessionId: "other" },
      { taskId: "other" },
      { task: { ...task, taskId: "other" } },
      { action: "resume" },
    ])
      expect(() => parseProtocolV2TaskResult({ ...result, ...change }, params)).toThrow();
    const wake = { ...params, action: "wake", wakeId: "wake", sleepId: "sleep" } as const;
    expect(() =>
      parseProtocolV2TaskResult(
        { ...result, action: "wake", wakeId: "old", sleepId: "sleep", wakeStatus: "accepted" },
        wake,
      ),
    ).toThrow();
  });

  it("fork响应必须指向新会话并保留准确来源，不能把别的树作为成功", () => {
    const input = {
      action: "fork",
      sessionId: "bound",
      at: { sessionId: "bound", entryId: "node" },
    } as const;
    const tree = {
      sessionId: "new",
      activeBranch: "main",
      branches: [{ id: "main", leafId: null }],
      nodes: [],
      forkedFrom: input.at,
    };
    const output = { schemaVersion: 1, sessionId: "bound", action: "fork", tree };
    expect(parseProtocolV2SessionResult(output, input)).toEqual(output);
    expect(() =>
      parseProtocolV2SessionResult({ ...output, tree: { ...tree, sessionId: "bound" } }, input),
    ).toThrow();
    expect(() =>
      parseProtocolV2SessionResult(
        { ...output, tree: { ...tree, forkedFrom: { ...input.at, entryId: "other" } } },
        input,
      ),
    ).toThrow();
  });

  it("TS客户端在传输前拦截指纹/能力缺失并绑定会话，在响应后核对身份", async () => {
    const send = vi.fn(async () => result);
    const options = {
      sessionId: "bound",
      initialized: {
        ...initialized,
        warnings: [],
        serverCapabilities: [...initialized.serverCapabilities],
      },
      request: send,
    };
    expect(
      () =>
        new ProtocolV2SessionClient({
          ...options,
          initialized: { ...options.initialized, schemaFingerprint: "sha256:bad" },
        }),
    ).toThrow();
    const unsupported = new ProtocolV2SessionClient({
      ...options,
      initialized: { ...options.initialized, serverCapabilities: [] },
    });
    await expect(unsupported.task({ action: "query", taskId: "job" })).rejects.toMatchObject({
      code: "protocol_capability_missing",
    });
    expect(send).not.toHaveBeenCalled();
    const client = new ProtocolV2SessionClient(options);
    expect(
      await client.task({ action: "start", taskId: "job", type: "demo", checkpoint: 0 }),
    ).toEqual(result);
    expect(send).toHaveBeenCalledWith("task", params);
    send.mockResolvedValue({ ...result, taskId: "other" });
    await expect(
      client.task({ action: "start", taskId: "job", type: "demo", checkpoint: 0 }),
    ).rejects.toThrow();
    const original = {
      data: {
        details: {
          operation: "task",
          action: "query",
          sessionId: "bound",
          taskId: "job",
          taskCode: "task_not_found",
        },
      },
    };
    send.mockRejectedValue(original);
    await expect(client.task({ action: "query", taskId: "job" })).rejects.toBe(original);
    send.mockRejectedValue({ data: { details: { ...original.data.details, taskId: "other" } } });
    await expect(client.task({ action: "query", taskId: "job" })).rejects.toThrow("身份不匹配");
  });
});

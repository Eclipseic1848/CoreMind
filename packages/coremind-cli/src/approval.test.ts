import type { CoreMindConfig, ToolApprovalRequest } from "coremind-ai";
import { describe, expect, it } from "vitest";
import { ApprovalQueue, applyPermissionMode } from "./approval.js";

const request = (id: string): ToolApprovalRequest => ({
  approvalId: id,
  runId: "run-1",
  agent: "main",
  tool: "read",
  args: { path: "notes.txt" },
  risk: "low",
  reason: "需要批准",
  effect: {
    operations: ["read"],
    paths: ["notes.txt"],
    urls: [],
    reversible: true,
    declared: true,
  },
});

describe("ApprovalQueue", () => {
  it("按顺序处理并发审批", async () => {
    const queue = new ApprovalQueue(true);
    const first = queue.request(request("a1"));
    const second = queue.request(request("a2"));

    expect(queue.current?.request.approvalId).toBe("a1");
    queue.resolve("allow");
    await expect(first).resolves.toBe("allow");
    expect(queue.current?.request.approvalId).toBe("a2");
    queue.resolve("deny");
    await expect(second).resolves.toBe("deny");
  });

  it("非交互环境安全拒绝审批", async () => {
    const queue = new ApprovalQueue(false);
    await expect(queue.request(request("a1"))).resolves.toBe("deny");
  });
});

describe("applyPermissionMode", () => {
  it("只覆盖权限模式并保留路径与网络策略", () => {
    const config: CoreMindConfig = {
      schemaVersion: 2,
      name: "test",
      agents: { main: { systemPrompt: "测试" } },
      permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
    };

    expect(applyPermissionMode(config, "full").permissions).toMatchObject({
      mode: "full",
      workspaceOnly: true,
      network: "deny",
    });
  });
});

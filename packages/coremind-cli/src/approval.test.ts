import type { CoreMindConfig, ToolApprovalRequest } from "coremind-ai";
import { describe, expect, it } from "vitest";
import {
  ApprovalQueue,
  applyPermissionMode,
  bindReadlineApprovals,
  formatDelegationApproval,
} from "./approval.js";

const request = (id: string): ToolApprovalRequest => ({
  approvalId: id,
  runId: "run-1",
  agent: "main",
  tool: "read",
  args: { path: "notes.txt" },
  argumentsFingerprint: "a".repeat(64),
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

  it("readline 委派审批明确显示固定目标、任务摘要和六维预算", async () => {
    const queue = new ApprovalQueue(true);
    const prompts: string[] = [];
    const delegationRequest: ToolApprovalRequest = {
      ...request("delegation-1"),
      tool: "delegate",
      args: {
        target: "researcher",
        task: `核验资料并返回证据${"很长的任务正文".repeat(80)}`,
        references: ["fact:requirements"],
        limits: {
          tokens: 1_000,
          toolCalls: 2,
          costUsd: 0.5,
          wallTimeMs: 5_000,
          steps: 3,
          descendants: 0,
        },
      },
      argumentsFingerprint: "b".repeat(64),
      delegationInputFingerprint: `sha256:${"c".repeat(64)}`,
      reason: "创建受限 Child Run",
      effect: { operations: ["read"], paths: [], urls: [], reversible: true, declared: true },
    };
    const unbind = bindReadlineApprovals(queue, {
      question: async (prompt) => {
        prompts.push(prompt);
        return "y";
      },
    });

    await expect(queue.request(delegationRequest)).resolves.toBe("allow");
    expect(prompts[0]).toContain("Child Run 委派审批：researcher");
    expect(prompts[0]).toContain("任务：核验资料并返回证据");
    expect(prompts[0]).not.toContain("很长的任务正文很长的任务正文很长的任务正文");
    expect(prompts[0]).toContain("预算：1000 tokens · 工具 2 · $0.5 · 5000ms · 步骤 3 · 后代 0");
    expect(prompts[0]).toContain("引用：fact:requirements");
    expect(formatDelegationApproval(delegationRequest)?.target).toBe("researcher");
    unbind();
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

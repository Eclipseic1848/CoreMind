import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type ToolApprovalRequest, ToolPolicy } from "./tool-policy.js";

describe("ToolPolicy", () => {
  it("显式 deny 在 full 模式下仍然优先", async () => {
    const policy = createPolicy({ mode: "full", deny: ["bash"] });
    await expect(policy.authorize("main", "bash", { command: "npm test" })).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("workspaceOnly 拒绝目录穿越", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: true });
    await expect(
      policy.authorize("main", "read", { path: "../secret.txt" }),
    ).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("超出工作区") });
  });

  it("assisted 自动批准工作区低风险工具，但敏感工具仍询问", async () => {
    const requests: ToolApprovalRequest[] = [];
    const policy = createPolicy({ mode: "assisted" }, async (request) => {
      requests.push(request);
      return "allow";
    });

    await expect(policy.authorize("main", "read", { path: "notes.txt" })).resolves.toMatchObject({
      allowed: true,
      approvedBy: "mode",
    });
    await expect(policy.authorize("main", "bash", { command: "npm test" })).resolves.toMatchObject({
      allowed: true,
      approvedBy: "user",
    });
    expect(requests.map((request) => request.tool)).toEqual(["bash"]);
  });

  it("需要审批但宿主未提供处理器时默认拒绝", async () => {
    const policy = createPolicy({ mode: "ask" });
    await expect(policy.authorize("main", "read", { path: "notes.txt" })).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("未提供审批处理器"),
    });
  });
});

function createPolicy(
  permissions: ConstructorParameters<typeof ToolPolicy>[0]["permissions"],
  approve?: ConstructorParameters<typeof ToolPolicy>[0]["approve"],
): ToolPolicy {
  return new ToolPolicy({
    permissions,
    cwd: mkdtempSync(path.join(tmpdir(), "coremind-policy-")),
    runId: "run-test",
    approve,
    createApprovalId: () => "approval-test",
  });
}

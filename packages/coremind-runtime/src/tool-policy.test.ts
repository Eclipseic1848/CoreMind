import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
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

  it("workspaceOnly 递归检查嵌套参数中的路径", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: true });
    await expect(
      policy.authorize("main", "read", { request: { input: { path: "../secret.txt" } } }),
    ).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("超出工作区") });
  });

  it("workspaceOnly 拒绝绝对路径与指向工作区外的目录链接", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-policy-workspace-"));
    const outside = mkdtempSync(path.join(tmpdir(), "coremind-policy-outside-"));
    const linked = path.join(cwd, "linked-outside");
    mkdirSync(path.join(outside, "nested"), { recursive: true });
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    const policy = createPolicyAt(cwd, { mode: "full", workspaceOnly: true });

    await expect(policy.authorize("main", "read", { path: outside })).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("超出工作区"),
    });
    await expect(
      policy.authorize("main", "read", { path: "linked-outside/nested/secret.txt" }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("超出工作区"),
    });
  });

  it.runIf(process.platform === "win32")("Windows 拒绝盘符与 UNC 路径", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: true }, undefined, "win32");

    await expect(
      policy.authorize("main", "read", { path: "Z:\\outside\\secret.txt" }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      policy.authorize("main", "read", { path: "\\\\server\\share\\secret.txt" }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("network deny 拒绝嵌套 URL，即使工具名不是内置网络工具", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: false, network: "deny" });
    await expect(
      policy.authorize(
        "main",
        "sync_customer",
        { request: { endpoint: { url: "https://example.com/customers" } } },
        { operations: ["network"], reversible: false },
      ),
    ).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("网络策略") });
  });

  it("Windows 无法证明 Shell 约束时 fail closed 并提示 WSL2", async () => {
    const policy = createPolicy(
      { mode: "full", workspaceOnly: true, network: "allow" },
      undefined,
      "win32",
    );
    await expect(policy.authorize("main", "bash", { command: "npm test" })).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("WSL2"),
    });
  });

  it("受约束模式拒绝未声明副作用的自定义工具", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: true, network: "ask" });
    await expect(policy.authorize("main", "custom_unknown", { value: "x" })).resolves.toMatchObject(
      {
        allowed: false,
        reason: expect.stringContaining("未声明副作用"),
      },
    );
  });

  it("workspaceOnly 拒绝未暴露目标路径的自定义写工具", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: true, network: "allow" });
    await expect(
      policy.authorize(
        "main",
        "hidden_writer",
        { value: "x" },
        { operations: ["write"], reversible: false },
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("目标路径"),
    });
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

  it("审批请求包含结构化 ToolEffect", async () => {
    const requests: ToolApprovalRequest[] = [];
    const policy = createPolicy({ mode: "ask" }, async (request) => {
      requests.push(request);
      return "allow";
    });

    await policy.authorize(
      "main",
      "publish_report",
      { output: { path: "reports/today.md" } },
      { operations: ["write"], reversible: true },
    );

    expect(requests[0]?.effect).toMatchObject({
      operations: ["write"],
      paths: ["reports/today.md"],
      reversible: true,
      declared: true,
    });
  });
});

function createPolicy(
  permissions: ConstructorParameters<typeof ToolPolicy>[0]["permissions"],
  approve?: ConstructorParameters<typeof ToolPolicy>[0]["approve"],
  platform: NodeJS.Platform = "linux",
): ToolPolicy {
  return createPolicyAt(
    mkdtempSync(path.join(tmpdir(), "coremind-policy-")),
    permissions,
    approve,
    platform,
  );
}

function createPolicyAt(
  cwd: string,
  permissions: ConstructorParameters<typeof ToolPolicy>[0]["permissions"],
  approve?: ConstructorParameters<typeof ToolPolicy>[0]["approve"],
  platform: NodeJS.Platform = "linux",
): ToolPolicy {
  return new ToolPolicy({
    permissions,
    cwd,
    runId: "run-test",
    approve,
    platform,
    createApprovalId: () => "approval-test",
  });
}

import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveToolCapability } from "coremind-tools";
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

  it("Child Run path allowlist 在实际 ToolPolicy 执行层阻断范围外访问", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-policy-child-paths-"));
    mkdirSync(path.join(cwd, "src"), { recursive: true });
    const policy = new ToolPolicy({
      permissions: { mode: "full", workspaceOnly: true },
      allowedPaths: ["src"],
      cwd,
      runId: "run-child-paths",
      createApprovalId: () => "approval-child-paths",
    });

    await expect(policy.authorize("main", "read", { path: "src/index.ts" })).resolves.toMatchObject(
      {
        allowed: true,
      },
    );
    await expect(policy.authorize("main", "read", { path: "README.md" })).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Child Run allowlist"),
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

  it("full 模式也拒绝 unknown 且无法建立 Checkpoint 的工具", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: false, network: "allow" });
    const capability = resolveToolCapability({
      tool: "registered_unknown",
      source: "registered",
      declaration: {
        effect: "unknown",
        replay: "unknown",
        concurrency: "run_serial",
        checkpoint: "unsupported",
        durability: "critical",
      },
    });

    await expect(
      policy.authorize("main", "registered_unknown", { value: "x" }, capability),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Checkpoint"),
    });
  });

  it("运行期伪造的残缺 Capability 在 full 模式也失败关闭", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: false, network: "allow" });

    await expect(
      policy.authorize("main", "forged_tool", {}, {
        resolution: "resolved",
        checkpoint: "none",
        durability: "ordinary",
      } as never),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("完整 Capability"),
    });
  });

  it("旧式声明包含非法字段选择器时不崩溃并失败关闭", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: false, network: "allow" });

    await expect(
      policy.authorize("main", "forged_legacy", {}, {
        operations: ["read"],
        reversible: true,
        pathFields: { nested: "path" },
      } as never),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("完整 Capability"),
    });
  });

  it("旧式网络声明接受合法 urlFields 选择器", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: false, network: "allow" });

    await expect(
      policy.authorize(
        "main",
        "legacy_fetch",
        { endpoint: "https://example.com/report" },
        {
          operations: ["network"],
          reversible: false,
          urlFields: ["endpoint"],
        },
      ),
    ).resolves.toMatchObject({ allowed: true, approvedBy: "configuration" });
  });

  it("旧式声明包含非法 urlFields 数组时失败关闭", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: false, network: "allow" });

    await expect(
      policy.authorize("main", "forged_legacy_url", {}, {
        operations: ["network"],
        reversible: false,
        urlFields: [1],
      } as never),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("完整 Capability"),
    });
  });

  it("完整形状的自定义 Capability 也不能伪造 builtin 来源", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: true, network: "allow" });

    await expect(
      policy.authorize(
        "main",
        "forged_builtin",
        {},
        {
          tool: "forged_builtin",
          effect: "workspace",
          replay: "idempotent",
          concurrency: "workspace_exclusive",
          checkpoint: "required",
          durability: "critical",
          source: "builtin",
          resolution: "resolved",
          issues: [],
        },
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("完整 Capability"),
    });
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

  it("受约束模式拒绝自定义工具的进程或外部副作用", async () => {
    const policy = createPolicy({ mode: "full", workspaceOnly: false, network: "ask" });

    await expect(
      policy.authorize(
        "main",
        "external_runner",
        { value: "x" },
        { operations: ["process"], reversible: false },
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("process/external"),
    });
  });

  it("network allow 对已声明的网络工具执行配置预授权", async () => {
    const policy = createPolicy({ mode: "ask", workspaceOnly: false, network: "allow" });

    await expect(
      policy.authorize(
        "main",
        "fetch_report",
        { url: "https://example.com/report" },
        { operations: ["network"], reversible: false },
      ),
    ).resolves.toMatchObject({
      allowed: true,
      approvedBy: "configuration",
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

  it("Delegation 严格遵守 ask、assisted 显式预批准与 full 矩阵", async () => {
    const args = {
      target: "researcher",
      task: "核验事实",
      references: ["fact:approved"],
      limits: {
        tokens: 800,
        toolCalls: 2,
        costUsd: 0.5,
        wallTimeMs: 5_000,
        steps: 3,
        descendants: 0,
      },
    };
    const requests: ToolApprovalRequest[] = [];
    const approve = async (request: ToolApprovalRequest) => {
      requests.push(request);
      return "allow" as const;
    };
    const createDelegationPolicy = (
      mode: "ask" | "assisted" | "full",
      assistedPreapprovedTargets: string[],
    ) =>
      new ToolPolicy({
        permissions: { mode, allow: ["delegate"] },
        cwd: mkdtempSync(path.join(tmpdir(), "coremind-delegation-policy-")),
        runId: "run-delegation",
        approve,
        createApprovalId: () => `approval-${requests.length + 1}`,
        delegation: {
          isAssistedPreapproved: (_agent, target) => assistedPreapprovedTargets.includes(target),
        },
      });

    await expect(
      createDelegationPolicy("ask", ["researcher"]).authorize(
        "main",
        "delegate",
        args,
        lowRiskDelegationCapability(),
      ),
    ).resolves.toMatchObject({ allowed: true, approvedBy: "user" });
    await expect(
      createDelegationPolicy("assisted", []).authorize(
        "main",
        "delegate",
        args,
        lowRiskDelegationCapability(),
      ),
    ).resolves.toMatchObject({ allowed: true, approvedBy: "user" });
    await expect(
      createDelegationPolicy("assisted", ["researcher"]).authorize(
        "main",
        "delegate",
        args,
        lowRiskDelegationCapability(),
      ),
    ).resolves.toMatchObject({ allowed: true, approvedBy: "configuration" });
    await expect(
      createDelegationPolicy("full", []).authorize(
        "main",
        "delegate",
        args,
        lowRiskDelegationCapability(),
      ),
    ).resolves.toMatchObject({ allowed: true, approvedBy: "mode" });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      tool: "delegate",
      args,
      argumentsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("Delegation Approval 指纹绑定目标、任务与生效限制", async () => {
    const requests: ToolApprovalRequest[] = [];
    const policy = new ToolPolicy({
      permissions: { mode: "ask" },
      cwd: mkdtempSync(path.join(tmpdir(), "coremind-delegation-fingerprint-")),
      runId: "run-delegation-fingerprint",
      approve: async (request) => {
        requests.push(request);
        return "allow";
      },
      createApprovalId: () => `approval-${requests.length + 1}`,
      delegation: { isAssistedPreapproved: () => false },
    });
    const base = {
      target: "researcher",
      task: "核验事实",
      references: ["fact:approved"],
      limits: {
        tokens: 800,
        toolCalls: 2,
        costUsd: 0.5,
        wallTimeMs: 5_000,
        steps: 3,
        descendants: 0,
      },
    };

    await policy.authorize("main", "delegate", base, lowRiskDelegationCapability());
    await policy.authorize("main", "delegate", { ...base }, lowRiskDelegationCapability());
    await policy.authorize(
      "main",
      "delegate",
      { ...base, task: "修改后的任务" },
      lowRiskDelegationCapability(),
    );
    await policy.authorize(
      "main",
      "delegate",
      { ...base, limits: { ...base.limits, tokens: 799 } },
      lowRiskDelegationCapability(),
    );

    expect(requests[0]?.argumentsFingerprint).toBe(requests[1]?.argumentsFingerprint);
    expect(requests[2]?.argumentsFingerprint).not.toBe(requests[0]?.argumentsFingerprint);
    expect(requests[3]?.argumentsFingerprint).not.toBe(requests[0]?.argumentsFingerprint);
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

function lowRiskDelegationCapability() {
  return resolveToolCapability({
    tool: "delegate",
    source: "registered",
    declaration: {
      effect: "none",
      replay: "safe",
      concurrency: "run_serial",
      checkpoint: "none",
      durability: "critical",
    },
  });
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

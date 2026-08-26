import { describe, expect, it } from "vitest";
import {
  createFakeExecutionEnvironment,
  createLinuxSandboxExecutionEnvironment,
  createTrustedHostExecutionEnvironment,
  resolveExecutionEnvironment,
  tightenExecutionEnvironmentRequirement,
} from "./execution-environment.js";

describe("ExecutionEnvironment", () => {
  it("Adapter 虚报受控 egress 时以负向 probe 为准并失败关闭", async () => {
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "deny_all" },
      observed: { networkEgress: "unrestricted" },
    });

    await expect(
      resolveExecutionEnvironment(environment, { networkEgress: "controlled" }),
    ).rejects.toMatchObject({ code: "environment_capability_mismatch" });
  });

  it("Linux 平台名不能替代 sandbox 依赖与负向 probe", async () => {
    const environment = createLinuxSandboxExecutionEnvironment({
      workspaceRoot: process.cwd(),
      platform: "linux",
      probeSandbox: async () => ({ available: false, evidence: ["bwrap-missing"] }),
    });

    expect(environment.claimedCapabilities.identity.platform).toBe("linux");
    await expect(
      resolveExecutionEnvironment(environment, { isolation: "sandbox" }),
    ).rejects.toMatchObject({ code: "environment_probe_failed" });
  });

  it("Linux sandbox 还必须证明真实进程树终止能力", async () => {
    const environment = createLinuxSandboxExecutionEnvironment({
      workspaceRoot: process.cwd(),
      platform: "linux",
      probeSandbox: async () => ({ available: true, evidence: ["sandbox-negative-probes:passed"] }),
      probeProcessControl: async () => ({
        available: false,
        evidence: ["descendant-survived"],
      }),
    });

    await expect(
      resolveExecutionEnvironment(environment, {
        isolation: "sandbox",
        processControl: "process_tree",
        termination: { kill: "process_tree", timeout: true },
      }),
    ).rejects.toMatchObject({ code: "environment_probe_failed" });
  });

  it("Trusted Host 平台名不能替代真实进程树终止 probe", async () => {
    const environment = createTrustedHostExecutionEnvironment({
      workspaceRoot: process.cwd(),
      platform: "win32",
      probeProcessControl: async () => ({
        available: false,
        evidence: ["descendant-survived"],
      }),
    });

    await expect(
      resolveExecutionEnvironment(environment, {
        processControl: "process_tree",
        termination: { kill: "process_tree", timeout: true },
      }),
    ).rejects.toMatchObject({ code: "environment_probe_failed" });
  });

  it("路径与凭据能力虚报时失败关闭", async () => {
    const environment = createFakeExecutionEnvironment({
      claimed: {
        networkEgress: "unrestricted",
        readAccess: "workspace",
        outsideWorkspaceAccess: "blocked",
        credentialIsolation: "environment_and_files",
      },
      observed: {
        networkEgress: "unrestricted",
        readAccess: "unrestricted",
        outsideWorkspaceAccess: "allowed",
        credentialIsolation: "none",
      },
    });

    await expect(resolveExecutionEnvironment(environment, {})).rejects.toMatchObject({
      code: "environment_capability_mismatch",
    });
  });

  it("诚实报告 unrestricted egress 仍不能满足受控网络要求", async () => {
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    });

    await expect(
      resolveExecutionEnvironment(environment, { networkEgress: "controlled" }),
    ).rejects.toMatchObject({ code: "environment_requirement_unsatisfied" });
  });

  it("子级要求只能维持或收紧继承的环境约束", () => {
    expect(
      tightenExecutionEnvironmentRequirement(
        {
          networkEgress: "denied",
          writeAccess: "none",
          credentialIsolation: "environment_and_files",
        },
        {
          networkEgress: "controlled",
          writeAccess: "workspace",
          credentialIsolation: "environment",
        },
      ),
    ).toMatchObject({
      networkEgress: "denied",
      writeAccess: "none",
      credentialIsolation: "environment_and_files",
    });
  });

  it("缺失 critical durability 或完整进程树终止能力时失败关闭", async () => {
    const environment = createFakeExecutionEnvironment({
      claimed: {
        networkEgress: "unrestricted",
        processControl: "process",
        termination: { kill: "process", timeout: false, pty: false },
        durability: "process_memory",
      },
      observed: {
        networkEgress: "unrestricted",
        processControl: "process",
        termination: { kill: "process", timeout: false, pty: false },
        durability: "process_memory",
      },
    });

    await expect(
      resolveExecutionEnvironment(environment, {
        processControl: "process_tree",
        termination: { kill: "process_tree", timeout: true },
        durability: "critical",
      }),
    ).rejects.toMatchObject({ code: "environment_requirement_unsatisfied" });
  });

  it("环境活动无视 abort 时 terminate 失败且不能宣称 Quiescent", async () => {
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
      terminationTimeoutMs: 10,
    });
    const activity = environment.beginActivity({ id: "process-1", kind: "process" });

    await expect(environment.terminate("cancel")).rejects.toMatchObject({
      code: "environment_terminate_failed",
    });
    expect(activity.signal.aborted).toBe(true);
    expect(environment.isQuiescent()).toBe(false);

    activity.settle();
    expect(environment.isQuiescent()).toBe(true);
  });
});

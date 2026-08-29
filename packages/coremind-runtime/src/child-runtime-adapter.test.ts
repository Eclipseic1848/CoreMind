import "../../../test/setup-env.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ChildRunExecutionAdapter,
  type ChildRunExecutionInput,
  childRunInputFingerprint,
} from "./child-run.js";
import {
  createCoreMindChildRunAdapter,
  isCoreMindChildRunAdapter,
} from "./child-runtime-adapter.js";
import { CoreMindRuntime, type RunResult } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CoreMind Child Runtime Adapter", () => {
  it("官方 wrapper 也拒绝结构相同但未经 CoreMindRuntime.create 注册的伪 Runtime", async () => {
    let authorityChecks = 0;
    const adapter = createCoreMindChildRunAdapter({
      createRuntime: async () =>
        ({
          verifyChildRunAuthority: async () => {
            authorityChecks += 1;
          },
          run: async () => ({ runId: "run-child" }),
          waitForQuiescence: async () => true,
        }) as never,
    });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "child_run_identity_mismatch",
    });
    expect(authorityChecks).toBe(0);
    expect(isCoreMindChildRunAdapter(adapter)).toBe(true);
    expect(
      isCoreMindChildRunAdapter({ execute: async () => ({}) } as ChildRunExecutionAdapter),
    ).toBe(false);
  });

  it("真实注册 Runtime 的 RunId 漂移时拒绝结果", async () => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () => ({ runId: "run-other" }) as RunResult;
    runtime.waitForQuiescence = async () => true;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "child_run_identity_mismatch",
    });
  });

  it("真实注册 Runtime 未静止时拒绝结构化结果", async () => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () => ({ runId: "run-child" }) as RunResult;
    runtime.waitForQuiescence = async () => false;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "child_run_not_quiescent",
    });
  });
});

function executionInput(): ChildRunExecutionInput {
  const model = {
    providerId: "probe",
    model: "probe-model",
    providerConfigFingerprint: "sha256:test-provider-config",
    agentPromptFingerprint: "sha256:test-agent-prompt",
    agentDelegationFingerprint: "sha256:test-agent-delegation",
  };
  const workspace = { canonicalRoot: "C:/test-workspace", lease: "shared_canonical" as const };
  const permissions = {
    mode: "ask" as const,
    workspaceOnly: true,
    network: "ask" as const,
    tools: [],
    paths: [],
    credentials: [],
  };
  const allocation = {
    tokens: 10,
    toolCalls: 0,
    costUsd: 1,
    wallTimeMs: 1_000,
    steps: 1,
    descendants: 0,
  };
  const request = {
    delegationId: "delegation-child-adapter",
    parentTurnId: "turn-parent",
    parentStepId: "step-parent",
    agentName: "main",
    task: "执行子任务",
    model,
    workspace,
    lifecyclePolicy: {
      join: "structured" as const,
      cancel: "propagate_parent" as const,
      orphan: "audit_pause" as const,
      detach: "forbidden" as const,
    },
    context: { workingSetFingerprint: "sha256:child-adapter", references: [] },
    allocation,
    permissions,
    environment: {},
  };
  return {
    parentRunId: "run-parent",
    childRunId: "run-child",
    delegationId: request.delegationId,
    inputFingerprint: childRunInputFingerprint(request),
    request,
    inheritedPolicy: {
      depth: 1,
      budget: allocation,
      permissions,
      environment: {},
      model,
      workspace,
      protectedContextReferences: [],
      maxDepth: 3,
      maxActiveChildren: 1,
      maxDescendants: 0,
    },
    signal: new AbortController().signal,
  };
}

async function createRegisteredRuntime(): Promise<CoreMindRuntime> {
  const configDir = mkdtempSync(path.join(tmpdir(), "coremind-child-adapter-runtime-"));
  temporaryDirectories.push(configDir);
  return CoreMindRuntime.create({
    config: {
      schemaVersion: 2,
      name: "Child Adapter 测试",
      provider: {
        id: "probe",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "probe-model",
        apiKeyEnv: "COREMIND_TEST_API_KEY",
      },
      agents: { main: {} },
    },
    configDir,
    cwd: configDir,
  });
}

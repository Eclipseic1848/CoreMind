import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChildRunExecutionAdapter, ChildRunExecutionInput } from "./child-run.js";
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

    await expect(
      adapter.execute({ childRunId: "run-child" } as ChildRunExecutionInput),
    ).rejects.toMatchObject({ code: "child_run_identity_mismatch" });
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

    await expect(
      adapter.execute({ childRunId: "run-child" } as ChildRunExecutionInput),
    ).rejects.toMatchObject({ code: "child_run_identity_mismatch" });
  });

  it("真实注册 Runtime 未静止时拒绝结构化结果", async () => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () => ({ runId: "run-child" }) as RunResult;
    runtime.waitForQuiescence = async () => false;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(
      adapter.execute({ childRunId: "run-child" } as ChildRunExecutionInput),
    ).rejects.toMatchObject({ code: "child_run_not_quiescent" });
  });
});

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
        apiKey: "test-key",
      },
      agents: { main: {} },
    },
    configDir,
    cwd: configDir,
  });
}

import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it } from "vitest";
import { type ChildRunExecutionInput, childRunInputFingerprint } from "./child-run.js";
import { createCoreMindChildRunAdapter } from "./child-runtime-adapter.js";
import { checkProject } from "./project-check.js";
import { defineTool } from "./public-tool.js";
import type { RunStore } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";

const unsafeConfig: CoreMindConfig = {
  schemaVersion: 2,
  name: "execution-security",
  provider: {
    id: "gateway",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "probe",
    apiKey: "plaintext-secret",
  },
  agents: { main: {} },
  permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
};

describe("Execution Security Gate", () => {
  it("TypeScript Runtime 在构造执行依赖前拒绝明文 apiKey", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-security-runtime-"));

    await expect(
      CoreMindRuntime.create({ config: unsafeConfig, configDir: cwd, cwd, env: {} }),
    ).rejects.toMatchObject({ code: "execution_security_violation" });
  });

  it("SecretRef 缺少 resolver 时安全失败且不泄漏引用", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-security-secret-ref-"));
    const opaqueRef = "opaque/provider/key/never-log";
    const config: CoreMindConfig = {
      ...unsafeConfig,
      provider: {
        id: "gateway",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "probe",
        apiKeySecretRef: { secretRef: opaqueRef },
      },
    };

    const creation = CoreMindRuntime.create({ config, configDir: cwd, cwd, env: {} });
    await expect(creation).rejects.toMatchObject({ code: "secret_reference_unresolved" });
    await expect(creation).rejects.not.toThrow(opaqueRef);
  });

  it("resolver 异常与空白结果统一脱敏为稳定错误", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-security-resolver-error-"));
    const opaqueRef = "opaque/provider/key/never-log";
    const resolvedSecret = "resolved-value-never-log";
    const config: CoreMindConfig = {
      ...unsafeConfig,
      provider: {
        id: "gateway",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "probe",
        apiKeySecretRef: { secretRef: opaqueRef },
      },
    };

    for (const resolve of [
      async () => {
        throw new Error(`${opaqueRef}:${resolvedSecret}`);
      },
      async () => "   ",
    ]) {
      const creation = CoreMindRuntime.create({
        config,
        configDir: cwd,
        cwd,
        env: {},
        secretResolver: { resolve },
      });
      await expect(creation).rejects.toMatchObject({ code: "secret_reference_unresolved" });
      await expect(creation).rejects.not.toThrow(opaqueRef);
      await expect(creation).rejects.not.toThrow(resolvedSecret);
    }
  });

  it.each(["Authorization", "proxy-authorization", "X-Api-Key", "COOKIE"])(
    "check 与 Runtime 以同一码拒绝敏感 Header %s 的字面量",
    async (header) => {
      const cwd = mkdtempSync(path.join(tmpdir(), "coremind-security-header-"));
      const config: CoreMindConfig = {
        ...unsafeConfig,
        provider: {
          id: "gateway",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "probe",
          headers: { [header]: "literal-secret" },
        },
      };

      const report = await checkProject({ config, projectDir: cwd });
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          code: "execution_security_violation",
          path: `provider.headers.${header}`,
        }),
      );
      await expect(
        CoreMindRuntime.create({ config, configDir: cwd, cwd, env: {} }),
      ).rejects.toMatchObject({ code: "execution_security_violation" });
    },
  );

  it("显式 apiKeyEnv 缺失时 check 与 Runtime 在执行前失败", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-security-env-"));
    const config: CoreMindConfig = {
      ...unsafeConfig,
      provider: {
        id: "gateway",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "probe",
        apiKeyEnv: "MISSING_GATEWAY_KEY",
      },
    };

    const report = await checkProject({ config, projectDir: cwd, env: {} });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "secret_reference_unresolved", path: "provider.apiKeyEnv" }),
    );
    await expect(
      CoreMindRuntime.create({ config, configDir: cwd, cwd, env: {} }),
    ).rejects.toMatchObject({ code: "secret_reference_unresolved" });
  });

  it("内置 Provider 的默认环境变量缺失时 check 与 Runtime 同码失败", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-security-default-env-"));
    const config: CoreMindConfig = {
      ...unsafeConfig,
      provider: { id: "deepseek" },
    };

    const report = await checkProject({ config, projectDir: cwd, env: {} });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "secret_reference_unresolved" }),
    );
    await expect(
      CoreMindRuntime.create({ config, configDir: cwd, cwd, env: {} }),
    ).rejects.toMatchObject({ code: "secret_reference_unresolved" });
  });

  it("普通 Header 字面量与存在的环境变量引用继续可用", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-security-safe-header-"));
    const config: CoreMindConfig = {
      ...unsafeConfig,
      provider: {
        id: "gateway",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "probe",
        apiKeyEnv: "GATEWAY_API_KEY",
        headers: { "X-Tenant-Id": "tenant-a" },
      },
    };

    const report = await checkProject({
      config,
      projectDir: cwd,
      env: { GATEWAY_API_KEY: "test-only" },
    });
    expect(
      report.findings.filter((finding) =>
        ["execution_security_violation", "secret_reference_unresolved"].includes(finding.code),
      ),
    ).toEqual([]);
    await expect(
      CoreMindRuntime.create({
        config,
        configDir: cwd,
        cwd,
        env: { GATEWAY_API_KEY: "test-only" },
      }),
    ).resolves.toBeInstanceOf(CoreMindRuntime);
  });

  it("成功解析的引用和值不进入事件、Fact、结果或持久化", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-security-no-persistence-"));
    const opaqueRef = "opaque/provider/success/never-log";
    const resolvedSecret = "resolved-success-never-log";
    const persisted: unknown[] = [];
    const events: unknown[] = [];
    const provider = createServer((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${resolvedSecret}`);
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "security-1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "safe" }, finish_reason: null }],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "security-2",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const port = (provider.address() as AddressInfo).port;
    const runStore: RunStore = {
      append: async (record) => {
        persisted.push(record);
      },
      read: async () => [],
    };

    try {
      const runtime = await CoreMindRuntime.create({
        config: {
          ...unsafeConfig,
          provider: {
            id: "gateway",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe",
            apiKeySecretRef: { secretRef: opaqueRef },
          },
        },
        configDir: cwd,
        cwd,
        initialPrompt: "probe",
        events: (event) => events.push(event),
        runStore,
        secretResolver: { resolve: async () => resolvedSecret },
      });
      const result = await runtime.run();
      const observable = JSON.stringify({ persisted, events, result });
      expect(observable).not.toContain(opaqueRef);
      expect(observable).not.toContain(resolvedSecret);
    } finally {
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("拒绝配置时 Provider、Tool 与 Child Run Fact 均为零", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-security-zero-side-effects-"));
    let providerCalls = 0;
    let toolCalls = 0;
    let factWrites = 0;
    const provider = createServer((_request, response) => {
      providerCalls += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const port = (provider.address() as AddressInfo).port;
    const runStore: RunStore = {
      append: async () => {
        factWrites += 1;
      },
      read: async () => [],
    };
    const tool = defineTool({
      name: "must_not_execute",
      description: "安全门负向验收探针",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      effect: { operations: ["read"], reversible: true },
      execute: async () => {
        toolCalls += 1;
        return { unexpected: true };
      },
    });

    try {
      await expect(
        CoreMindRuntime.create({
          config: {
            ...unsafeConfig,
            provider: {
              id: "gateway",
              baseUrl: `http://127.0.0.1:${port}/v1`,
              model: "probe",
              headers: { Authorization: "Bearer plaintext-secret" },
            },
          },
          configDir: cwd,
          cwd,
          env: {},
          runStore,
          toolDefinitions: [tool],
        }),
      ).rejects.toMatchObject({ code: "execution_security_violation" });
      expect(providerCalls).toBe(0);
      expect(toolCalls).toBe(0);
      expect(factWrites).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("Child Run Adapter 在子 Runtime 构造阶段返回同一错误且不写 Fact", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-security-child-run-"));
    let factWrites = 0;
    const adapter = createCoreMindChildRunAdapter({
      createRuntime: async () =>
        CoreMindRuntime.create({
          config: unsafeConfig,
          configDir: cwd,
          cwd,
          env: {},
          runStore: {
            append: async () => {
              factWrites += 1;
            },
            read: async () => [],
          },
        }),
    });

    await expect(adapter.execute(childExecutionInput(cwd))).rejects.toMatchObject({
      code: "execution_security_violation",
    });
    expect(factWrites).toBe(0);
  });
});

function childExecutionInput(cwd: string): ChildRunExecutionInput {
  const model = {
    providerId: "gateway",
    model: "probe",
    providerConfigFingerprint: "sha256:test-provider-config",
    agentPromptFingerprint: "sha256:test-agent-prompt",
    agentDelegationFingerprint: "sha256:test-agent-delegation",
  };
  const workspace = { canonicalRoot: cwd, lease: "shared_canonical" as const };
  const permissions = {
    mode: "ask" as const,
    workspaceOnly: true,
    network: "deny" as const,
    tools: [],
    paths: [],
    credentials: [],
  };
  const allocation = {
    tokens: 1,
    toolCalls: 0,
    costUsd: 0,
    wallTimeMs: 1_000,
    steps: 1,
    descendants: 0,
  };
  const request = {
    delegationId: "delegation-security",
    parentTurnId: "turn-security",
    parentStepId: "step-security",
    agentName: "main",
    task: "验证安全门",
    model,
    workspace,
    lifecyclePolicy: {
      join: "structured" as const,
      cancel: "propagate_parent" as const,
      orphan: "audit_pause" as const,
      detach: "forbidden" as const,
    },
    context: { workingSetFingerprint: "sha256:security", references: [] },
    allocation,
    permissions,
    environment: {},
  };
  return {
    parentRunId: "run-parent-security",
    childRunId: "child-security",
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
      maxDepth: 1,
      maxActiveChildren: 1,
      maxDescendants: 0,
    },
    signal: new AbortController().signal,
  };
}

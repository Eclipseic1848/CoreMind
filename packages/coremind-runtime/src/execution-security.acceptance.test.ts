import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it } from "vitest";
import type { ChildRunExecutionInput } from "./child-run.js";
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
    ).rejects.toMatchObject({ code: "invalid_config" });
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
        expect.objectContaining({ code: "invalid_config", path: `provider.headers.${header}` }),
      );
      await expect(
        CoreMindRuntime.create({ config, configDir: cwd, cwd, env: {} }),
      ).rejects.toMatchObject({ code: "invalid_config" });
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
      expect.objectContaining({ code: "invalid_config", path: "provider.apiKeyEnv" }),
    );
    await expect(
      CoreMindRuntime.create({ config, configDir: cwd, cwd, env: {} }),
    ).rejects.toMatchObject({ code: "invalid_config" });
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
    expect(report.findings.filter((finding) => finding.code === "invalid_config")).toEqual([]);
    await expect(
      CoreMindRuntime.create({
        config,
        configDir: cwd,
        cwd,
        env: { GATEWAY_API_KEY: "test-only" },
      }),
    ).resolves.toBeInstanceOf(CoreMindRuntime);
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
      ).rejects.toMatchObject({ code: "invalid_config" });
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

    await expect(
      adapter.execute({ childRunId: "child-security" } as ChildRunExecutionInput),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(factWrites).toBe(0);
  });
});

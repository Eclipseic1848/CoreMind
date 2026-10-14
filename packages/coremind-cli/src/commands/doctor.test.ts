import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkApiKeyEnvironment, cmdDoctor, resolveConfiguredApiKeyEnv } from "./doctor.js";

describe("doctor Provider 凭据检查", () => {
  it("优先使用配置声明的 apiKeyEnv", () => {
    expect(
      resolveConfiguredApiKeyEnv({
        provider: { id: "alibaba-model-studio", apiKeyEnv: " CUSTOM_PROVIDER_KEY " },
      }),
    ).toBe("CUSTOM_PROVIDER_KEY");
    expect(
      checkApiKeyEnvironment("CUSTOM_PROVIDER_KEY", { CUSTOM_PROVIDER_KEY: "test-key" }),
    ).toMatchObject({ ok: true, detail: expect.stringContaining("CUSTOM_PROVIDER_KEY 已配置") });
    expect(checkApiKeyEnvironment("CUSTOM_PROVIDER_KEY", {})).toEqual({
      ok: false,
      detail: "未配置：CUSTOM_PROVIDER_KEY（仅检查存在性）",
    });
  });

  it("识别 Alibaba 默认变量，其他未声明入口继续使用通用体检", () => {
    expect(resolveConfiguredApiKeyEnv({ provider: { id: "alibaba-model-studio" } })).toBe(
      "DASHSCOPE_API_KEY",
    );
    expect(resolveConfiguredApiKeyEnv({ provider: { id: "deepseek" } })).toBeUndefined();
    expect(resolveConfiguredApiKeyEnv({})).toBeUndefined();
  });

  it("无配置文件时保留常见变量体检语义", () => {
    expect(checkApiKeyEnvironment(undefined, {})).toMatchObject({
      ok: false,
      detail: expect.stringContaining("DEEPSEEK_API_KEY"),
    });
    expect(checkApiKeyEnvironment(undefined, { OPENAI_API_KEY: "test-key" })).toMatchObject({
      ok: true,
      detail: expect.stringContaining("DEEPSEEK_API_KEY"),
    });
    expect(
      checkApiKeyEnvironment(undefined, {
        DEEPSEEK_API_KEY: "test-key",
        OPENAI_API_KEY: "test-key",
        MOONSHOT_API_KEY: "test-key",
        ZAI_API_KEY: "test-key",
      }),
    ).toEqual({
      ok: true,
      detail: "常见提供商 key 均已配置（仅检查存在性，未验证有效性）",
    });
  });

  it.each([
    { name: "安全默认值", permissions: undefined, selected: true, supported: false },
    {
      name: "full 不能绕过工作区",
      permissions: { mode: "full", workspaceOnly: true, network: "allow" },
      selected: true,
      supported: false,
    },
    {
      name: "禁网",
      permissions: { mode: "full", workspaceOnly: false, network: "deny" },
      selected: true,
      supported: false,
    },
    {
      name: "询问网络",
      permissions: { mode: "ask", workspaceOnly: false, network: "ask" },
      selected: true,
      supported: false,
    },
    {
      name: "trusted_host",
      permissions: { mode: "ask", workspaceOnly: false, network: "allow" },
      selected: true,
      supported: true,
    },
    { name: "Agent 未选择全局服务", permissions: undefined, selected: false, supported: true },
  ])(
    "$name：真实 doctor 命令只诊断本地 MCP，不启动配置程序",
    async ({ permissions, selected, supported }) => {
      const directory = mkdtempSync(path.join(tmpdir(), "coremind-doctor-mcp-"));
      const marker = path.join(directory, "service-started");
      const file = path.join(directory, "coremind.json");
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.stubEnv("DEEPSEEK_API_KEY", "doctor-test-only");
      try {
        writeFileSync(
          file,
          JSON.stringify({
            schemaVersion: 2,
            name: "doctor-mcp",
            provider: { id: "deepseek" },
            permissions,
            agents: { main: selected ? { tools: [] } : { tools: [{ id: "read" }] } },
            tools: [
              {
                mcp: { server: "local", tool: "lookup" },
                effect: { operations: ["external"], reversible: false },
                capability: {
                  effect: "external",
                  replay: "unknown",
                  concurrency: "run_serial",
                  checkpoint: "unsupported",
                  durability: "critical",
                },
              },
            ],
            mcp: {
              servers: {
                local: {
                  transport: "stdio",
                  command: process.execPath,
                  args: [
                    "-e",
                    "require('node:fs').writeFileSync(process.argv[1], 'started', 'utf8')",
                    marker,
                  ],
                  cwd: directory,
                },
              },
            },
          }),
          "utf8",
        );
        const code = await cmdDoctor({ flags: new Map(), positionals: [] }, [file]);
        const text = output.mock.calls.flat().join("\n");
        expect(code).toBe(supported ? 0 : 1);
        if (selected) {
          expect(text).toContain("本地 MCP 执行条件");
          expect(text).toContain("未启动服务");
          expect(text).toContain(supported ? "仅静态检查" : "workspaceOnly=false 和 network=allow");
        } else expect(text).not.toContain("本地 MCP 执行条件");
        expect(existsSync(marker)).toBe(false);
      } finally {
        output.mockRestore();
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

  it("识别 Alibaba 原生入口默认变量，自定义端点不推断默认凭据", () => {
    expect(resolveConfiguredApiKeyEnv({ provider: { id: "alibaba-model-studio" } })).toBe(
      "DASHSCOPE_API_KEY",
    );
    expect(resolveConfiguredApiKeyEnv({ provider: { id: "deepseek" } })).toBeUndefined();
    expect(resolveConfiguredApiKeyEnv({})).toBeUndefined();
    expect(
      resolveConfiguredApiKeyEnv({
        provider: { id: "alibaba-model-studio", baseUrl: "http://127.0.0.1:9/v1" },
      }),
    ).toBeUndefined();
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
    {
      name: "匿名端点沿用 Alibaba 标识",
      provider: { id: "alibaba-model-studio", baseUrl: "http://127.0.0.1:9/v1", model: "probe" },
      configured: false,
      expected: 0,
    },
    {
      name: "仅 Header 认证",
      provider: {
        id: "doctor-custom",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "probe",
        headers: { Authorization: { env: "DOCTOR_HEADER_KEY" } },
      },
      configured: false,
      expected: 0,
    },
    {
      name: "显式凭据缺失",
      provider: {
        id: "doctor-custom",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "probe",
        apiKeyEnv: "DOCTOR_EXPLICIT_KEY",
      },
      configured: true,
      expected: 1,
    },
    { name: "内置凭据缺失", provider: { id: "deepseek" }, configured: false, expected: 1 },
  ])("$name：真实 doctor 复用 Provider 认证策略且不加载脚本或发请求", async (item) => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-doctor-provider-auth-"));
    const file = path.join(directory, "coremind.json");
    const marker = path.join(directory, "imported");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("不应发送请求"));
    for (const key of [
      "DEEPSEEK_API_KEY",
      "OPENAI_API_KEY",
      "MOONSHOT_API_KEY",
      "ZAI_API_KEY",
      "DASHSCOPE_API_KEY",
      "DOCTOR_CUSTOM_API_KEY",
      "DOCTOR_EXPLICIT_KEY",
    ])
      vi.stubEnv(key, "");
    vi.stubEnv("DOCTOR_HEADER_KEY", "doctor-test-only");
    try {
      writeFileSync(
        path.join(directory, "probe.mjs"),
        'import {writeFileSync} from "node:fs"; writeFileSync(new URL("./imported", import.meta.url), "loaded", "utf8"); export default {};\n',
        "utf8",
      );
      writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 2,
          name: "doctor-provider-auth",
          provider: item.provider,
          agents: { main: {} },
          tools: [{ path: "probe.mjs", effect: { operations: ["read"], reversible: true } }],
        }),
        "utf8",
      );
      const code = await cmdDoctor({ flags: new Map(), positionals: [] }, [file]);
      const text = output.mock.calls.flat().join("\n");
      expect(code, text).toBe(item.expected);
      expect(text).not.toContain("未配置：DEEPSEEK_API_KEY");
      if (item.configured) expect(text).toContain("未配置：DOCTOR_EXPLICIT_KEY");
      expect(text).not.toContain("doctor-test-only");
      expect(existsSync(marker)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
      output.mockRestore();
      vi.unstubAllEnvs();
      expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir()));
      rmSync(directory, { recursive: true, force: true });
    }
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

  it.each(
    (["allow", "ask", "deny"] as const).flatMap((network) =>
      (["tool", "resource"] as const).map((selection) => ({ network, selection })),
    ),
  )(
    "HTTP $selection/network=$network：真实 doctor 不建立连接也不要求解除工作区限制",
    async ({ network, selection }) => {
      const directory = mkdtempSync(path.join(tmpdir(), "coremind-doctor-http-mcp-"));
      const file = path.join(directory, "coremind.json");
      let connections = 0;
      let requests = 0;
      const service = createServer((_request, response) => {
        requests += 1;
        response.writeHead(500).end();
      });
      service.on("connection", () => {
        connections += 1;
      });
      await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
      const port = (service.address() as AddressInfo).port;
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.stubEnv("DEEPSEEK_API_KEY", "doctor-test-only");
      try {
        writeFileSync(
          file,
          JSON.stringify({
            schemaVersion: 2,
            name: "doctor-http-mcp",
            provider: { id: "deepseek" },
            permissions: { mode: "ask", workspaceOnly: true, network },
            agents: {
              main:
                selection === "resource"
                  ? { mcpResources: { remote: ["inventory://item/1"] } }
                  : {
                      tools: [
                        {
                          mcp: { server: "remote", tool: "lookup" },
                          effect: { operations: ["network"], reversible: false },
                          capability: {
                            effect: "network",
                            replay: "unknown",
                            concurrency: "parallel",
                            checkpoint: "none",
                            durability: "critical",
                          },
                        },
                      ],
                    },
            },
            mcp: {
              servers: {
                remote: {
                  transport: "streamable-http",
                  url: `http://127.0.0.1:${port}/mcp`,
                  allowedAddresses: ["127.0.0.1"],
                  headers: { Authorization: { env: "UNSET_STATIC_MCP_TOKEN" } },
                },
              },
            },
          }),
          "utf8",
        );
        const code = await cmdDoctor({ flags: new Map(), positionals: [] }, [file]);
        const text = output.mock.calls.flat().join("\n");
        expect(code).toBe(network === "deny" ? 1 : 0);
        expect(text).toContain("HTTP MCP 执行条件");
        expect(text).toContain("未连接服务");
        expect(text).not.toContain("本地 MCP 执行条件");
        expect(text).not.toContain("workspaceOnly=false");
        if (network === "ask") expect(text).toContain("审批");
        expect({ connections, requests }).toEqual({ connections: 0, requests: 0 });
      } finally {
        output.mockRestore();
        vi.unstubAllEnvs();
        service.closeAllConnections();
        await new Promise<void>((resolve) => service.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

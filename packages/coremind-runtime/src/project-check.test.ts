import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { scaffoldProjectGuidance } from "coremind-templates";
import { describe, expect, it } from "vitest";
import { checkProject } from "./project-check.js";

const baseConfig: CoreMindConfig = {
  schemaVersion: 2,
  name: "quality-check",
  agents: { main: { systemPrompt: "测试助手" } },
  runtime: {},
  permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
  quality: { profile: "standard", allowOverride: true },
};

describe("checkProject", () => {
  it("standard 项目材料齐全且无明文密钥时通过", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "coremind-check-pass-"));
    await scaffoldProjectGuidance({
      target: projectDir,
      projectName: "quality-check",
      language: "typescript",
    });

    const report = await checkProject({
      config: baseConfig,
      projectDir,
      env: { DEEPSEEK_API_KEY: "test-only" },
    });

    expect(report.passed).toBe(true);
    expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("明文 API key 返回统一的不可覆盖配置错误", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "coremind-check-secret-"));
    const report = await checkProject({
      config: {
        ...baseConfig,
        provider: {
          id: "gateway",
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "m1",
          apiKey: "secret",
        },
      },
      projectDir,
      env: { DEEPSEEK_API_KEY: "test-only" },
      overrideReason: "我接受风险",
    });

    expect(report.passed).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "execution_security_violation", overridable: false }),
    );
  });

  it("非安全材料缺失可按配置记录原因后覆盖", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "coremind-check-override-"));
    const report = await checkProject({
      config: baseConfig,
      projectDir,
      env: { DEEPSEEK_API_KEY: "test-only" },
      overrideReason: "临时原型，评审后补齐",
    });

    expect(report.passed).toBe(true);
    expect(report.overrideRecord?.reason).toContain("临时原型");
    expect(report.overrideRecord?.auditFile).toBe(
      path.join(projectDir, ".coremind", "quality-overrides.jsonl"),
    );
    expect(existsSync(report.overrideRecord!.auditFile)).toBe(true);
    expect(readFileSync(report.overrideRecord!.auditFile, "utf8")).toContain("临时原型");
  });

  it.each([
    { name: "未声明权限", permissions: undefined, selected: true, supported: false },
    {
      name: "full 仍约束工作区",
      permissions: { mode: "full", workspaceOnly: true, network: "allow" },
      selected: true,
      supported: false,
    },
    {
      name: "禁止网络",
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
      name: "显式 trusted_host",
      permissions: { mode: "ask", workspaceOnly: false, network: "allow" },
      selected: true,
      supported: true,
    },
    {
      name: "Agent 未选择全局服务",
      permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
      selected: false,
      supported: true,
    },
  ] as const)(
    "$name：仅静态诊断 MCP，不启动服务且不覆盖旧安全门",
    async ({ permissions, selected, supported }) => {
      const projectDir = mkdtempSync(path.join(tmpdir(), "coremind-check-mcp-"));
      const marker = path.join(projectDir, "service-started");
      const config: CoreMindConfig = {
        ...baseConfig,
        permissions,
        agents: selected ? baseConfig.agents : { main: { tools: [{ id: "read" }] } },
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
              cwd: projectDir,
            },
          },
        },
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
      };
      try {
        const report = await checkProject({
          config,
          projectDir,
          env: { DEEPSEEK_API_KEY: "test-only" },
          profile: "development",
          overrideReason: "不能覆盖执行能力边界",
        });
        const finding = report.findings.find((entry) => entry.code === "MCP_TRUSTED_HOST_REQUIRED");
        if (supported) expect(finding).toBeUndefined();
        else {
          expect(finding).toMatchObject({
            severity: "error",
            path: "permissions",
            overridable: false,
          });
          expect(finding?.overridden).not.toBe(true);
          expect(report.passed).toBe(false);
        }
        if (permissions?.workspaceOnly === false) {
          expect(report.findings).toContainEqual(
            expect.objectContaining({ code: "SECURITY_WORKSPACE_UNBOUNDED", overridable: false }),
          );
          expect(report.passed).toBe(false);
        }
        if (!selected) expect(report.passed).toBe(true);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );

  it.each(
    (["allow", "ask", "deny"] as const).flatMap((network) =>
      (["tool", "resource"] as const).map((selection) => ({ network, selection })),
    ),
  )(
    "HTTP $selection/network=$network：保留工作区边界且静态检查零连接",
    async ({ network, selection }) => {
      const projectDir = mkdtempSync(path.join(tmpdir(), "coremind-check-http-mcp-"));
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
      const config: CoreMindConfig = {
        ...baseConfig,
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
            },
          },
        },
      };
      try {
        const report = await checkProject({
          config,
          projectDir,
          env: { DEEPSEEK_API_KEY: "test-only" },
          profile: "development",
          overrideReason: "不可覆盖网络拒绝",
        });
        expect(
          report.findings.some((finding) => finding.code === "MCP_TRUSTED_HOST_REQUIRED"),
        ).toBe(false);
        expect(
          report.findings.some((finding) => finding.code === "SECURITY_WORKSPACE_UNBOUNDED"),
        ).toBe(false);
        expect(report.passed).toBe(network !== "deny");
        if (network === "deny") {
          expect(report.findings).toContainEqual(
            expect.objectContaining({
              code: "MCP_HTTP_NETWORK_DENIED",
              path: "permissions.network",
              overridable: false,
            }),
          );
        }
        expect({ connections, requests }).toEqual({ connections: 0, requests: 0 });
      } finally {
        service.closeAllConnections();
        await new Promise<void>((resolve) => service.close(() => resolve()));
        rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );
});

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const allowed = {
  vite: { maximumSeverity: "high" },
  vitepress: { maximumSeverity: "moderate" },
  esbuild: { maximumSeverity: "moderate" },
};

function report(findings: Record<string, string> = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(
      Object.entries(findings).map(([name, severity]) => [name, { severity }]),
    ),
    metadata: { vulnerabilities: { total: Object.keys(findings).length } },
  };
}

function result(body: unknown = report(), status = 0) {
  return {
    pid: 1,
    status,
    signal: null,
    output: [],
    stdout: JSON.stringify(body),
    stderr: "",
  } as ReturnType<typeof spawnSync>;
}

async function check() {
  await import("./check-security-audit.mjs");
}

beforeEach(() => {
  vi.resetModules();
  vi.mocked(readFile).mockReset();
  vi.mocked(readFile)
    .mockResolvedValueOnce(
      JSON.stringify({ expiresAt: "2999-09-30", allowedDevelopmentOnlyPackages: allowed }),
    )
    .mockResolvedValueOnce(JSON.stringify({ scripts: {} }));
  vi.mocked(spawnSync).mockReset().mockReturnValue(result());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("audit rejected");
  });
});

afterEach(() => vi.restoreAllMocks());

describe("安全审计结果边界", () => {
  it.each([{}, { vite: "high" }, { vite: "high", vitepress: "moderate", esbuild: "moderate" }])(
    "允许合法零风险报告或已登记风险子集：%j",
    async (findings) => {
      vi.mocked(spawnSync)
        .mockReturnValueOnce(result())
        .mockReturnValueOnce(result(report(findings), Object.keys(findings).length ? 1 : 0));
      await expect(check()).resolves.toBeUndefined();
      expect(spawnSync).toHaveBeenCalledTimes(2);
    },
  );

  it.each([{ unreviewed: "low" }, { toString: "low" }, { vite: "critical" }, { vite: "unknown" }])(
    "拒绝未登记、超等级或未知等级风险：%j",
    async (findings) => {
      vi.mocked(spawnSync)
        .mockReturnValueOnce(result())
        .mockReturnValueOnce(result(report(findings), 1));
      await expect(check()).rejects.toThrow("audit rejected");
    },
  );

  it("生产漏洞不可由开发依赖登记放行", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce(result(report({ vite: "high" }), 1));
    await expect(check()).rejects.toThrow("audit rejected");
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("保留完整审计的网络失败原因", async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result({ message: "network timeout at: audit endpoint", error: {} }, 1));
    await expect(check()).rejects.toThrow("audit rejected");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("network timeout"));
  });

  it.each([
    null,
    {},
    { vulnerabilities: {} },
    { ...report(), vulnerabilities: [] },
    { ...report(), metadata: { vulnerabilities: { total: 1 } } },
    { ...report(), error: {} },
  ])("拒绝不完整或自相矛盾的报告：%j", async (body) => {
    vi.mocked(spawnSync).mockReturnValueOnce(result()).mockReturnValueOnce(result(body));
    await expect(check()).rejects.toThrow("audit rejected");
  });

  it.each([1, 2, null])("零风险 JSON 不得掩盖失败退出状态：%s", async (status) => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(result())
      .mockReturnValueOnce({ ...result(), status });
    await expect(check()).rejects.toThrow("audit rejected");
  });

  it("继续拒绝过期策略和开发服务器入口", async () => {
    for (const [expiresAt, scripts] of [
      ["2000-01-01", {}],
      ["2999-09-30", { "docs:dev": "vitepress" }],
      ["2999-09-30", { "docs:preview": "vitepress" }],
    ] as const) {
      vi.resetModules();
      vi.mocked(readFile)
        .mockReset()
        .mockResolvedValueOnce(
          JSON.stringify({ expiresAt, allowedDevelopmentOnlyPackages: allowed }),
        )
        .mockResolvedValueOnce(JSON.stringify({ scripts }));
      await expect(check()).rejects.toThrow("audit rejected");
    }
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const allowed = {
  vite: {
    maximumSeverity: "high",
    versions: ["1.0.0"],
    advisories: ["https://github.com/advisories/GHSA-reviewed-vite"],
  },
  vitepress: {
    maximumSeverity: "moderate",
    versions: ["1.0.0"],
    advisories: ["https://github.com/advisories/GHSA-reviewed-vitepress"],
  },
  esbuild: {
    maximumSeverity: "moderate",
    versions: ["1.0.0"],
    advisories: ["https://github.com/advisories/GHSA-reviewed-esbuild"],
  },
};

function report(findings: Record<string, string> = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(
      Object.entries(findings).map(([name, severity]) => [
        name,
        {
          severity,
          nodes: [`node_modules/${name}`],
          via: [{ url: `https://github.com/advisories/GHSA-reviewed-${name}` }],
        },
      ]),
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
    .mockResolvedValueOnce(JSON.stringify({ scripts: {} }))
    .mockResolvedValueOnce(
      JSON.stringify({
        packages: Object.fromEntries(
          Object.keys(allowed).map((name) => [`node_modules/${name}`, { version: "1.0.0" }]),
        ),
      }),
    );
  vi.mocked(spawnSync).mockReset().mockReturnValue(result());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("audit rejected");
  });
});

afterEach(() => vi.restoreAllMocks());

describe("安全审计结果边界", () => {
  function preparePi() {
    const packages = {
      "pi-agent": {
        maximumSeverity: "high",
        versions: ["1.0.0"],
        nodes: ["node_modules/pi-agent"],
        advisories: ["https://github.com/advisories/GHSA-reviewed-undici"],
      },
      undici: {
        maximumSeverity: "high",
        versions: ["1.0.0"],
        nodes: ["node_modules/pi-agent/node_modules/undici"],
        advisories: ["https://github.com/advisories/GHSA-reviewed-undici"],
      },
    };
    vi.mocked(readFile)
      .mockReset()
      .mockResolvedValueOnce(
        JSON.stringify({
          expiresAt: "2999-09-30",
          acceptedPiPackages: packages,
          allowedDevelopmentOnlyPackages: allowed,
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ scripts: {} }))
      .mockResolvedValueOnce(
        JSON.stringify({
          packages: Object.fromEntries(
            [
              ...Object.keys(allowed).map((name) => `node_modules/${name}`),
              "node_modules/pi-agent",
              "node_modules/pi-agent/node_modules/undici",
              "node_modules/undici",
            ].map((node) => [node, { version: "1.0.0" }]),
          ),
        }),
      );
    const findings = report({ "pi-agent": "high", undici: "high" });
    Object.assign(findings.vulnerabilities["pi-agent"], { via: ["undici"] });
    findings.vulnerabilities.undici.nodes = ["node_modules/pi-agent/node_modules/undici"];
    return findings;
  }

  it("仅接受登记的 Pi 传递风险，并明确风险没有消失", async () => {
    const pi = preparePi();
    const complete = {
      ...pi,
      vulnerabilities: { ...pi.vulnerabilities, ...report({ vite: "high" }).vulnerabilities },
      metadata: { vulnerabilities: { total: 3 } },
    };
    vi.mocked(spawnSync)
      .mockReturnValueOnce(result(pi, 1))
      .mockReturnValueOnce(result(complete, 1));
    await expect(check()).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("2 个生产依赖风险"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("风险接受不代表漏洞已修复"));
  });

  it.each(["production", "complete"])("%s 审计拒绝 Pi 接受范围外的实例", async (scope) => {
    const pi = preparePi();
    const changed = structuredClone(pi);
    changed.vulnerabilities.undici.nodes.push("node_modules/undici");
    vi.mocked(spawnSync)
      .mockReturnValueOnce(result(scope === "production" ? changed : pi, 1))
      .mockReturnValueOnce(result(changed, 1));
    await expect(check()).rejects.toThrow("audit rejected");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("安装位置不在已接受"));
  });

  it.each(["advisory", "version", "severity", "source", "unrelated"])(
    "Pi 接受不放行未经核实的变化：%s",
    async (change) => {
      const pi = preparePi();
      if (change === "advisory")
        pi.vulnerabilities.undici.via = [{ url: "https://github.com/advisories/GHSA-new-risk" }];
      if (change === "version") pi.vulnerabilities.undici.nodes = ["node_modules/unknown"];
      if (change === "severity") pi.vulnerabilities.undici.severity = "critical";
      if (change === "source") pi.vulnerabilities.undici.via = [];
      if (change === "unrelated") {
        Object.assign(pi.vulnerabilities, report({ vite: "high" }).vulnerabilities);
        pi.metadata.vulnerabilities.total += 1;
      }
      vi.mocked(spawnSync).mockReturnValueOnce(result(pi, 1));
      await expect(check()).rejects.toThrow("audit rejected");
    },
  );

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

  it("npm 审计等级改变退出码时仍允许完整的已登记风险报告", async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result(report({ vite: "high" }), 0));
    await expect(check()).resolves.toBeUndefined();
  });

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

  it.each(["version", "advisory", "missing-source"])(
    "拒绝已登记包的未审查变化：%s",
    async (change) => {
      const changed = report({ vite: "high" });
      if (change === "version")
        changed.vulnerabilities.vite.nodes = ["node_modules/unreviewed-vite"];
      if (change === "advisory")
        changed.vulnerabilities.vite.via = [{ url: "https://github.com/advisories/GHSA-new-risk" }];
      if (change === "missing-source") changed.vulnerabilities.vite.via = [];
      vi.mocked(spawnSync).mockReturnValueOnce(result()).mockReturnValueOnce(result(changed, 1));
      await expect(check()).rejects.toThrow("audit rejected");
    },
  );

  it("递归核对传递风险公告，不能只凭外层包名放行", async () => {
    const transitive = report({ vite: "high", esbuild: "moderate" });
    Object.assign(transitive.vulnerabilities.vite, { via: ["esbuild"] });
    vi.mocked(spawnSync).mockReturnValueOnce(result()).mockReturnValueOnce(result(transitive, 1));
    await expect(check()).rejects.toThrow("audit rejected");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("未审查的安全公告"));
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
      ["not-a-date", {}],
      ["2999-02-30", {}],
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

import dns from "node:dns/promises";
import { expect, it, vi } from "vitest";
import { startMcpHttpServer } from "../../../test/fixtures/mcp-http-server.mjs";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { createMcpHttpFetch, validateMcpHttpAddress } from "./mcp-http-fetch.js";

const environment = () =>
  createFakeExecutionEnvironment({
    claimed: { networkEgress: "unrestricted" },
    observed: { networkEgress: "unrestricted" },
  });

it("构造和未启动关闭不产生 DNS、请求或活动", async () => {
  const lookup = vi.spyOn(dns, "lookup");
  const runEnvironment = environment();
  try {
    const owner = createMcpHttpFetch({
      url: "https://example.com/mcp",
      headers: {},
      runEnvironment,
    });
    expect(owner.environmentSummary).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(runEnvironment.isQuiescent()).toBe(true);
    await owner.close();
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
  }
});

it.each([
  "https://name:password@example.com/mcp",
  "https://example.com/mcp?token=private",
  "https://example.com/mcp#private",
  "file:///etc/passwd",
  "http://localhost/mcp",
])("固定目标拒绝有歧义或不安全的 URL：%s", (url) => {
  expect(() => createMcpHttpFetch({ url, headers: {}, runEnvironment: environment() })).toThrow(
    expect.objectContaining({ code: "mcp_http_policy_denied" }),
  );
});

it.each([
  { Host: "other.example" },
  { "Keep-Alive": "timeout=10" },
  { TE: "trailers" },
  { Trailer: "Authorization" },
  { Upgrade: "websocket" },
  { DPoP: "untrusted" },
  { "x bad": "value" },
  { "x-key": "first", "X-Key": "second" },
  { "x-key": "value\r\ninjected: yes" },
])("直接工厂也拒绝非法、重复及传输保留 Header：%j", (headers) => {
  expect(() =>
    createMcpHttpFetch({ url: "https://example.com/mcp", headers, runEnvironment: environment() }),
  ).toThrow(expect.objectContaining({ code: "mcp_http_policy_denied" }));
});

it("显式 Cookie 不被误当作自动 cookie jar 或传输保留头", async () => {
  const owner = createMcpHttpFetch({
    url: "https://example.com/mcp",
    headers: { Cookie: "session=explicit" },
    runEnvironment: environment(),
  });
  await owner.close();
});

it.each([
  "0.0.0.0",
  "169.254.169.254",
  "224.0.0.1",
  "::",
  "fe80::1",
  "ff02::1",
  "::ffff:169.254.169.254",
])("即使精确允许也拒绝不可访问地址 %s", (address) => {
  expect(() => validateMcpHttpAddress(address, "https:", [address])).toThrow(
    expect.objectContaining({ code: "mcp_http_policy_denied" }),
  );
});

it("私网和 IPv4 映射地址要求精确授权，HTTP 只允许 loopback 字面量", () => {
  expect(() => validateMcpHttpAddress("10.0.0.2", "https:", [])).toThrow(
    expect.objectContaining({ code: "mcp_http_policy_denied" }),
  );
  expect(validateMcpHttpAddress("10.0.0.2", "https:", ["10.0.0.2"])).toBe("10.0.0.2");
  expect(() => validateMcpHttpAddress("::ffff:127.0.0.1", "https:", [])).toThrow(
    expect.objectContaining({ code: "mcp_http_policy_denied" }),
  );
  expect(validateMcpHttpAddress("::ffff:127.0.0.1", "http:", ["127.0.0.1"])).toBe("127.0.0.1");
  expect(() => validateMcpHttpAddress("10.0.0.2", "http:", ["10.0.0.2"])).toThrow(
    expect.objectContaining({ code: "mcp_http_policy_denied" }),
  );
});

it("非空 allowedAddresses 同时约束公网目标，无列表才默认允许公网", () => {
  expect(() => validateMcpHttpAddress("93.184.216.34", "https:", ["8.8.8.8"])).toThrow(
    expect.objectContaining({ code: "mcp_http_policy_denied" }),
  );
  expect(validateMcpHttpAddress("93.184.216.34", "https:", ["93.184.216.34"])).toBe(
    "93.184.216.34",
  );
  expect(validateMcpHttpAddress("93.184.216.34", "https:", [])).toBe("93.184.216.34");
});

it("实际 socket lookup 必须验证完整 A/AAAA，不能只取第一个公网结果", async () => {
  const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
    { address: "::ffff:169.254.169.254", family: 6 },
  ]);
  const owner = createMcpHttpFetch({
    url: "https://mcp-test.invalid/mcp",
    headers: {},
    runEnvironment: environment(),
  });
  try {
    await expect(
      owner.fetch("https://mcp-test.invalid/mcp", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ code: "mcp_http_policy_denied" });
    expect(lookup).toHaveBeenCalledWith("mcp-test.invalid", { all: true, verbatim: true });
  } finally {
    await owner.close();
    lookup.mockRestore();
  }
});

it("DNS 仍未完成时 close 可收敛，迟到解析结果不会恢复连接", async () => {
  const service = await startMcpHttpServer();
  let release!: (records: { address: string; family: number }[]) => void;
  const pending = new Promise<{ address: string; family: number }[]>((resolve) => {
    release = resolve;
  });
  const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => pending);
  const runEnvironment = environment();
  const url = service.url.replace("http://127.0.0.1", "https://pending-dns.invalid");
  const owner = createMcpHttpFetch({
    url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment,
  });
  try {
    const fetching = owner.fetch(url, { method: "POST", body: "{}" });
    const cancelled = expect(fetching).rejects.toMatchObject({ code: "mcp_request_cancelled" });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(runEnvironment.isQuiescent()).toBe(false);
    await owner.close();
    await cancelled;
    expect(runEnvironment.isQuiescent()).toBe(true);
    release([{ address: "127.0.0.1", family: 4 }]);
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.sockets.size).toBe(0);
    expect(service.records.filter((record) => record.type === "http")).toHaveLength(0);
  } finally {
    release([{ address: "127.0.0.1", family: 4 }]);
    await owner.close();
    lookup.mockRestore();
    await service.close();
  }
});

it.each(["redirect", "unauthorized", "forbidden", "error-secret"])(
  "%s 不自动跳转、重放或回显远端秘密",
  async (mode) => {
    const secret = "http-private-923684";
    const service = await startMcpHttpServer({ mode, secret });
    const owner = createMcpHttpFetch({
      url: service.url,
      headers: { authorization: `Bearer ${secret}` },
      allowedAddresses: ["127.0.0.1"],
      runEnvironment: environment(),
      sensitiveValues: [secret],
    });
    try {
      let error: unknown;
      try {
        await owner.fetch(service.url, { method: "POST", body: "{}" });
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeDefined();
      expect(String(error)).not.toContain(secret);
      expect(service.records.filter((record) => record.type === "http")).toHaveLength(1);
      expect(service.records.some((record) => record.path === "/redirect-target")).toBe(false);
    } finally {
      await owner.close();
      await service.close();
    }
  },
);

it("响应头返回后活动仍存活，取消正文后结算，close 等待真实 socket 关闭", async () => {
  const service = await startMcpHttpServer({ mode: "slow" });
  const domain = environment();
  const runEnvironment = Object.assign(environment(), { hostNetwork: domain });
  const owner = createMcpHttpFetch({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment,
  });
  try {
    const response = await owner.fetch(service.url, { method: "POST", body: "{}" });
    expect(runEnvironment.isQuiescent()).toBe(false);
    expect(domain.isQuiescent()).toBe(false);
    expect(service.sockets.size).toBeGreaterThan(0);
    await response.body!.cancel();
    await vi.waitFor(() => expect(runEnvironment.isQuiescent()).toBe(true));
    expect(domain.isQuiescent()).toBe(true);
    await owner.close();
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
    await owner.close();
  } finally {
    await owner.close();
    await service.close();
  }
});

it("owner 的 64 MiB 累计限额不会在成功响应后重置", async () => {
  const service = await startMcpHttpServer({ mode: "body-limit" });
  const owner = createMcpHttpFetch({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment: environment(),
  });
  try {
    for (let index = 0; index < 8; index += 1) {
      const response = await owner.fetch(service.url, { method: "POST", body: "{}" });
      expect((await response.arrayBuffer()).byteLength).toBe(8 * 1024 * 1024);
    }
    const response = await owner.fetch(service.url, { method: "POST", body: "{}" });
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: "mcp_http_limit_exceeded" });
  } finally {
    await owner.close();
    await service.close();
  }
});

it("取消一个请求不会结束同 owner 的另一个合法请求", async () => {
  const service = await startMcpHttpServer({ mode: "slow" });
  const runEnvironment = environment();
  const owner = createMcpHttpFetch({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment,
  });
  try {
    const controller = new AbortController();
    const [first, second] = await Promise.all([
      owner.fetch(service.url, { method: "POST", body: "{}", signal: controller.signal }),
      owner.fetch(service.url, { method: "POST", body: "{}" }),
    ]);
    const firstBody = first.text();
    controller.abort();
    await expect(firstBody).rejects.toBeDefined();
    expect(runEnvironment.isQuiescent()).toBe(false);
    service.release();
    expect(await second.text()).toBe("开始结束");
    expect(runEnvironment.isQuiescent()).toBe(true);
  } finally {
    await owner.close();
    await service.close();
  }
});

it.each(["body-oversize", "gzip-oversize", "event-oversize"])(
  "真实 %s 响应在解压后/事件边界受 8 MiB 限制",
  async (mode) => {
    const service = await startMcpHttpServer({ mode });
    const owner = createMcpHttpFetch({
      url: service.url,
      headers: {},
      allowedAddresses: ["127.0.0.1"],
      runEnvironment: environment(),
    });
    try {
      const response = await owner.fetch(service.url, { method: "POST", body: "{}" });
      await expect(response.text()).rejects.toMatchObject({ code: "mcp_http_limit_exceeded" });
    } finally {
      await owner.close();
      await service.close();
    }
  },
);

it("跨 chunk 秘密也不进入完整响应", async () => {
  const secret = "secret-across-chunks-740195";
  const service = await startMcpHttpServer({ mode: "secret-body", secret });
  const owner = createMcpHttpFetch({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment: environment(),
    sensitiveValues: [secret],
  });
  try {
    const response = await owner.fetch(service.url, { method: "POST", body: "{}" });
    await expect(response.text()).rejects.toMatchObject({ code: "mcp_secret_blocked" });
  } finally {
    await owner.close();
    await service.close();
  }
});

it("包含 JSON 转义字符的响应 Header 秘密同样被拦截", async () => {
  const secret = 'header-secret-"\\-903514';
  const service = await startMcpHttpServer({ mode: "secret-header", secret });
  const owner = createMcpHttpFetch({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment: environment(),
    sensitiveValues: [secret],
  });
  try {
    await expect(owner.fetch(service.url, { method: "POST", body: "{}" })).rejects.toMatchObject({
      code: "mcp_secret_blocked",
    });
  } finally {
    await owner.close();
    await service.close();
  }
});

it("不同目标和未授权 loopback 在发送前拒绝", async () => {
  const service = await startMcpHttpServer();
  const owner = createMcpHttpFetch({
    url: service.url,
    headers: {},
    runEnvironment: environment(),
  });
  try {
    await expect(owner.fetch(service.url, { method: "POST", body: "{}" })).rejects.toMatchObject({
      code: "mcp_http_policy_denied",
    });
    expect(service.records.filter((record) => record.type === "http")).toHaveLength(0);
  } finally {
    await owner.close();
    await service.close();
  }
});

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFakeExecutionEnvironment,
  type ExecutionEnvironment,
} from "./execution-environment.js";
import {
  createWebFetchTool,
  createWebFetchToolForEnvironment,
  createWebSearchToolForEnvironment,
  stripHtml,
} from "./web-tools.js";

const webToolKinds = ["fetch", "search"] as const;

describe("Web 响应正文清理", () => {
  it.each(webToolKinds)("%s 拒绝持续返回的 503 后停止传输，不遗留环境活动", async (kind) => {
    let closed = false;
    let writing: ReturnType<typeof setInterval> | undefined;
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.write("持续错误正文");
      writing = setInterval(() => response.write("继续传输"), 5);
      response.on("close", () => {
        closed = true;
        clearInterval(writing);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("本地服务未分配端口");
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    });
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, init) => nativeFetch(`http://127.0.0.1:${address.port}`, init));
    try {
      await expect(executeWebTool(kind, environment)).rejects.toThrow("HTTP 503");
      await waitUntil(() => closed);
      expect(environment.isQuiescent()).toBe(true);
      await expect(environment.terminate("工具失败后收尾")).resolves.toBeUndefined();
    } finally {
      fetchMock.mockRestore();
      clearInterval(writing);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(webToolKinds)("%s 等待正文取消完成才返回，两域活动不提前结算", async (kind) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(() => gate);
    const response = new Response(new ReadableStream({ cancel }), { status: 503 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const hostNetwork = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    });
    const environment = Object.assign(
      createFakeExecutionEnvironment({
        claimed: { networkEgress: "deny_all" },
        observed: { networkEgress: "deny_all" },
      }),
      { hostNetwork },
    );
    let returned = false;
    const outcome = executeWebTool(kind, environment).catch((error) => {
      returned = true;
      return error;
    });
    try {
      await waitUntil(() => cancel.mock.calls.length > 0 || returned);
      expect(cancel).toHaveBeenCalledOnce();
      expect(returned).toBe(false);
      expect(environment.isQuiescent()).toBe(false);
      expect(hostNetwork.isQuiescent()).toBe(false);
      const terminating = environment.terminate("清理期间取消");
      release();
      expect(await outcome).toMatchObject({ message: expect.stringContaining("HTTP 503") });
      await terminating;
      expect(environment.isQuiescent()).toBe(true);
      expect(hostNetwork.isQuiescent()).toBe(true);
    } finally {
      release();
      await outcome;
      await response.body?.cancel();
      fetchMock.mockRestore();
    }
  });

  it.each(webToolKinds)("%s 的正文取消拒绝不覆盖原 HTTP 错误", async (kind) => {
    const cancel = vi.fn(async () => {
      throw new Error("清理自身失败");
    });
    const response = new Response(new ReadableStream({ cancel }), { status: 503 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    });
    try {
      await expect(executeWebTool(kind, environment)).rejects.toThrow("HTTP 503");
      expect(cancel).toHaveBeenCalledOnce();
      expect(environment.isQuiescent()).toBe(true);
    } finally {
      await response.body?.cancel().catch(() => undefined);
      fetchMock.mockRestore();
    }
  });

  it.each(webToolKinds)("%s 读取异常也等待正文清理，并保留原读取错误", async (kind) => {
    let cleaned = false;
    const cancel = vi.fn(async () => {
      await Promise.resolve();
      cleaned = true;
      throw new Error("清理自身失败");
    });
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    if (kind === "fetch") {
      const getReader = response.body!.getReader.bind(response.body!);
      vi.spyOn(response.body!, "getReader").mockImplementation(() => {
        const reader = getReader();
        vi.spyOn(reader, "read").mockRejectedValue(new Error("正文读取失败"));
        return reader;
      });
    } else {
      vi.spyOn(response, "json").mockRejectedValue(new Error("正文读取失败"));
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    });
    try {
      await expect(executeWebTool(kind, environment)).rejects.toThrow("正文读取失败");
      expect(cancel).toHaveBeenCalledOnce();
      expect(cleaned).toBe(true);
      expect(response.body?.locked).toBe(false);
      expect(environment.isQuiescent()).toBe(true);
    } finally {
      await response.body?.cancel().catch(() => undefined);
      fetchMock.mockRestore();
    }
  });

  it("搜索成功时保留 JSON 结果格式和摘要长度", async () => {
    const response = new Response(
      JSON.stringify({
        results: [{ title: "标题", url: "https://example.invalid", content: "文".repeat(400) }],
      }),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    });
    try {
      const result = await executeWebTool("search", environment);
      expect(result.content).toEqual([
        { type: "text", text: `1. 标题\n   https://example.invalid\n   ${"文".repeat(300)}` },
      ]);
      expect(environment.isQuiescent()).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("stripHtml", () => {
  it("去除标签并折叠空白", () => {
    expect(stripHtml("<h1>标题</h1><p>内容   <b>加粗</b></p>")).toBe("标题 内容 加粗");
  });

  it("移除 script/style 内容", () => {
    expect(stripHtml("<script>alert(1)</script>正文<style>.x{}</style>尾部")).toBe("正文 尾部");
  });

  it("解码 HTML 实体", () => {
    expect(stripHtml("a &amp; b &lt;c&gt; &quot;d&quot;")).toBe('a & b <c> "d"');
  });
});

describe("createWebFetchTool", () => {
  let port = 0;
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    if (req.url === "/page") {
      res.setHeader("content-type", "text/html");
      res.end("<html><body><h1>测试页</h1><p>这是<b>网页</b>内容</p></body></html>");
    } else if (req.url === "/slow") {
      // 由测试侧终止请求，用来验证网络活动的 Quiescent 收敛。
    } else if (req.url === "/slow-body") {
      res.write("正文读取中");
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr && typeof addr === "object") port = addr.port;
  });

  afterAll(() => {
    server.close();
  });

  it("抓取本地网页并转为纯文本", async () => {
    const tool = createWebFetchTool();
    const result = await tool.execute(
      "call-1",
      { url: `http://127.0.0.1:${port}/page` },
      undefined,
    );
    const text = result.content[0];
    expect(text.type).toBe("text");
    if (text.type === "text") {
      expect(text.text).toContain("测试页");
      expect(text.text).toContain("网页");
      expect(text.text).toContain("内容");
    }
  });

  it("404 时抛错", async () => {
    const tool = createWebFetchTool();
    await expect(
      tool.execute("call-1", { url: `http://127.0.0.1:${port}/missing` }, undefined),
    ).rejects.toThrow("404");
  });

  it("响应超过 2MiB 时取消读取，不能靠 maxChars 或 Content-Length 绕过", async () => {
    const cancel = vi.fn();
    let chunk = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024).fill(97));
          if (++chunk === 4) controller.close();
        },
        cancel,
      }),
      { headers: { "content-length": "1" } },
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      await expect(
        createWebFetchTool().execute(
          "oversize",
          { url: "https://example.invalid", maxChars: 500 },
          undefined,
        ),
      ).rejects.toThrow("响应超过 2 MiB 限制");
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("允许恰好 2MiB 并保留跨块 UTF-8 字符", async () => {
    const bytes = new TextEncoder().encode(`中${"a".repeat(2 * 1024 * 1024 - 3)}`);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1));
          controller.enqueue(bytes.slice(1));
          controller.close();
        },
      }),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      const result = await createWebFetchTool().execute(
        "boundary",
        { url: "https://example.invalid" },
        undefined,
      );
      expect(result.content[0]).toEqual({ type: "text", text: `中${"a".repeat(7999)}` });
      expect(response.body?.locked).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("maxChars 截断生效", async () => {
    const tool = createWebFetchTool();
    const result = await tool.execute(
      "call-1",
      { url: `http://127.0.0.1:${port}/page`, maxChars: 3 },
      undefined,
    );
    const text = result.content[0];
    if (text.type === "text") expect(text.text.length).toBeLessThanOrEqual(3);
  });

  it.each(["/slow", "/slow-body"])(
    "环境终止会取消网络活动并在 fetch 收尾后恢复 Quiescent：%s",
    async (route) => {
      const environment = createFakeExecutionEnvironment({
        claimed: { networkEgress: "unrestricted" },
        observed: { networkEgress: "unrestricted" },
        terminationTimeoutMs: 2_000,
      });
      const tool = createWebFetchToolForEnvironment(environment);
      let readingBody = false;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
        const response = await originalFetch(...args);
        readingBody = true;
        return response;
      });
      const fetching = tool.execute(
        "call-slow",
        { url: `http://127.0.0.1:${port}${route}` },
        undefined,
      );
      try {
        await waitUntil(() => !environment.isQuiescent());
        if (route === "/slow-body") await waitUntil(() => readingBody);

        const terminating = environment.terminate("测试取消");
        await expect(fetching).rejects.toThrow("失败");
        await expect(terminating).resolves.toBeUndefined();
        expect(environment.isQuiescent()).toBe(true);
      } finally {
        fetchMock.mockRestore();
      }
    },
  );

  it("显式宿主网络域允许抓取，父环境取消等待两个域收尾", async () => {
    const hostNetwork = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    });
    const environment = Object.assign(
      createFakeExecutionEnvironment({
        claimed: { networkEgress: "deny_all" },
        observed: { networkEgress: "deny_all" },
      }),
      { hostNetwork },
    );
    const tool = createWebFetchToolForEnvironment(environment);
    const result = await tool.execute("page", { url: `http://127.0.0.1:${port}/page` }, undefined);
    expect(JSON.stringify(result)).toContain("测试页");
    const fetching = tool.execute("slow", { url: `http://127.0.0.1:${port}/slow-body` }, undefined);
    await waitUntil(() => !hostNetwork.isQuiescent());
    expect(environment.isQuiescent()).toBe(false);
    const terminated = environment.terminate("测试取消");
    await expect(fetching).rejects.toThrow();
    await terminated;
    expect(environment.isQuiescent()).toBe(true);
    expect(hostNetwork.isQuiescent()).toBe(true);
  });

  it("受控或拒绝 egress 的环境不能由 host fetch 绕过", async () => {
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "deny_all" },
      observed: { networkEgress: "deny_all" },
    });
    const tool = createWebFetchToolForEnvironment(environment);
    const before = requestCount;

    await expect(
      tool.execute("call-denied", { url: `http://127.0.0.1:${port}/page` }, undefined),
    ).rejects.toThrow("host fetch 不在该控制边界内");
    expect(requestCount).toBe(before);
    expect(environment.isQuiescent()).toBe(true);
  });

  it("搜索读取真实响应期间取消会关闭正文并结算网络活动", async () => {
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    });
    const nativeFetch = globalThis.fetch;
    let readingBody = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const response = await nativeFetch(`http://127.0.0.1:${port}/slow-body`, init);
      readingBody = true;
      return response;
    });
    const outcome = executeWebTool("search", environment).catch((error) => error);
    try {
      await waitUntil(() => readingBody);
      const terminating = environment.terminate("取消搜索正文读取");
      expect(await outcome).toMatchObject({ message: expect.stringContaining("搜索失败") });
      await terminating;
      expect(environment.isQuiescent()).toBe(true);
    } finally {
      await environment.terminate("测试收尾");
      await outcome;
      fetchMock.mockRestore();
    }
  });
});

function executeWebTool(kind: (typeof webToolKinds)[number], environment: ExecutionEnvironment) {
  return kind === "fetch"
    ? createWebFetchToolForEnvironment(environment).execute(
        "web-cleanup",
        { url: "https://example.invalid" },
        undefined,
      )
    : createWebSearchToolForEnvironment({ TAVILY_API_KEY: "test-only" }, environment)!.execute(
        "web-cleanup",
        { query: "本地测试" },
        undefined,
      );
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

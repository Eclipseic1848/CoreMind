import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { createWebFetchTool, createWebFetchToolForEnvironment, stripHtml } from "./web-tools.js";

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
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("环境终止会取消网络活动并在 fetch 收尾后恢复 Quiescent", async () => {
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
      terminationTimeoutMs: 2_000,
    });
    const tool = createWebFetchToolForEnvironment(environment);
    const fetching = tool.execute("call-slow", { url: `http://127.0.0.1:${port}/slow` }, undefined);
    await waitUntil(() => !environment.isQuiescent());

    const terminating = environment.terminate("测试取消");
    await expect(fetching).rejects.toThrow("失败");
    await expect(terminating).resolves.toBeUndefined();
    expect(environment.isQuiescent()).toBe(true);
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
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

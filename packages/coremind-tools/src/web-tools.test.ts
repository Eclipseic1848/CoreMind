import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebFetchTool, stripHtml } from "./web-tools.js";

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
  const server = createServer((req, res) => {
    if (req.url === "/page") {
      res.setHeader("content-type", "text/html");
      res.end("<html><body><h1>测试页</h1><p>这是<b>网页</b>内容</p></body></html>");
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
});

import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { knowledgeEndpoint } from "./knowledge-endpoint.mts";

function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const query = process.argv.slice(2).join(" ").trim();
if (!query) throw new Error("请输入需要检索的知识问题");

const { url, authorization } = knowledgeEndpoint();
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: authorization }, redirect: "error" },
});
const client = new Client({ name: "coremind-direct-knowledge-example", version: "1.0.0" });
const options = { timeout: 10_000 };

async function call(name: string, args: Record<string, string | number>) {
  const result = await client.callTool({ name, arguments: args }, options);
  if (result.isError) throw new Error(`知识工具 ${name} 执行失败`);
  const content = result.content?.[0];
  assert(content?.type === "text", "知识工具应返回 JSON 文本");
  const payload: unknown = JSON.parse(content.text);
  assert(jsonObject(payload), "知识工具应返回 JSON 对象");
  return payload;
}

try {
  await client.connect(transport, options);
  const { citations } = await call("search_knowledge", { query });
  assert(Array.isArray(citations), "知识搜索应返回引文数组");
  const resolved = [];
  for (const citation of citations as unknown[]) {
    assert(jsonObject(citation), "引文应为 JSON 对象");
    const { docId, version, file, chunkId, line, locator, text } = citation;
    assert(
      typeof docId === "string" &&
        typeof version === "number" &&
        typeof file === "string" &&
        typeof text === "string",
      "引文缺少文档 ID、版本、文件或正文",
    );
    const identity = { docId, version, file };
    const position: Record<string, string | number> | null =
      typeof chunkId === "number"
        ? { chunkId }
        : typeof line === "number"
          ? { line }
          : typeof locator === "string"
            ? { locator }
            : null;
    assert(position, "引文缺少片段编号、行号或位置");
    const original = await call("resolve_citation", { ...identity, ...position });
    assert(original.status === "available" && original.text === text, "回查原文与检索片段不一致");
    resolved.push(original);
  }
  console.log(JSON.stringify({ citations, resolved }));
} catch {
  // SDK 的连接错误可能携带服务响应，命令行只报告当前操作失败。
  console.error("知识检索或引文回查失败，请检查服务、读令牌和返回结果。");
  process.exitCode = 1;
} finally {
  await client.close();
}

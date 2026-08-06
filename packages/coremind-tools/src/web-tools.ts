import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const WebFetchParams = Type.Object({
  url: Type.String({ format: "uri", description: "要抓取的网页地址" }),
  maxChars: Type.Optional(
    Type.Integer({ default: 8000, minimum: 500, description: "最多返回的字符数" }),
  ),
});

/**
 * web-fetch 工具：抓取网页并转为纯文本（去掉 HTML 标签），
 * 适合让模型读取公开网页信息。基于 Node 原生 fetch，零额外依赖。
 */
export function createWebFetchTool(): AgentTool<typeof WebFetchParams> {
  return {
    name: "web-fetch",
    label: "网页抓取",
    description:
      "抓取指定 URL 的网页内容并转为纯文本。用于获取公开网页、文档、文章信息。返回前 maxChars 字符。",
    parameters: WebFetchParams,
    execute: async (_toolCallId, params, signal) => {
      try {
        const res = await fetch(params.url, {
          signal,
          headers: { "user-agent": "CoreMind/0.1 (web-fetch)" },
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const html = await res.text();
        const text = stripHtml(html).slice(0, params.maxChars ?? 8000);
        if (text.trim().length === 0) {
          throw new Error("页面内容为空或无法解析");
        }
        return { content: [{ type: "text", text }], details: {} };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`抓取 ${params.url} 失败：${message}`);
      }
    },
  };
}

/** 简化 HTML 转纯文本：去 script/style、去标签、解码实体、折叠空白 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const SEARCH_KEY_ENV = "TAVILY_API_KEY";

const WebSearchParams = Type.Object({
  query: Type.String({ minLength: 1, description: "搜索关键词" }),
  maxResults: Type.Optional(Type.Integer({ default: 5, minimum: 1, maximum: 10 })),
});

/**
 * web-search 工具（可选）：需要 TAVILY_API_KEY 环境变量。
 * 未配置 key 时返回 null，由注册表跳过并告警——避免给模型一个永远失败的工具。
 */
export function createWebSearchToolIfAvailable(
  env: NodeJS.ProcessEnv = process.env,
): AgentTool<typeof WebSearchParams> | null {
  const key = env[SEARCH_KEY_ENV];
  if (!key) return null;

  return {
    name: "web-search",
    label: "网页搜索",
    description: "使用 Tavily 搜索公开网页，返回搜索结果摘要。用于查找最新信息。",
    parameters: WebSearchParams,
    execute: async (_toolCallId, params, signal) => {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: key,
            query: params.query,
            max_results: params.maxResults ?? 5,
          }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          results?: { title?: string; url?: string; content?: string }[];
        };
        const results = data.results ?? [];
        if (results.length === 0) throw new Error("无搜索结果");
        const text = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title ?? "无标题"}\n   ${r.url ?? ""}\n   ${(r.content ?? "").slice(0, 300)}`,
          )
          .join("\n");
        return { content: [{ type: "text", text }], details: {} };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`搜索失败：${message}`);
      }
    },
  };
}

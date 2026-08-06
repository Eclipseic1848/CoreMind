// 上游 API 冒烟验证脚本（离线，使用 faux provider）
// 运行：node scripts/smoke-upstream.mjs

import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, envApiKeyAuth } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createBashTool, createReadTool } from "@earendil-works/pi-coding-agent";

const results = [];
let failed = false;
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`✓ ${name}`);
  } catch (e) {
    failed = true;
    results.push(`✗ ${name}：${e.message}`);
  }
};

// 1. 模型层：createModels + faux provider
await check("pi-ai createModels/fauxProvider", () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  if (!model) throw new Error("无法获取 faux 模型");
  results.push(`    - 获取模型: ${model.id} (${model.provider})`);
});

// 2. 工具工厂签名验证
await check("coding-agent 工具工厂", () => {
  const read = createReadTool(process.cwd());
  const bash = createBashTool(process.cwd());
  for (const t of [read, bash]) {
    if (!t || typeof t.execute !== "function") throw new Error("工具缺少 execute");
    if (!t.name || !t.description) throw new Error("工具缺少 name/description");
  }
  results.push(`    - read: ${read.name}, bash: ${bash.name}`);
});

// 3. Agent 构建 + streamFn 接线 + 工具执行（完整离线循环）
await check("Agent 端到端（faux + 工具调用）", async () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  // 预置两步响应：先触发工具调用，再输出文本
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: "package.json" })]),
    fauxAssistantMessage("完成，文件内容已读取"),
  ]);

  const events = [];
  const agent = new Agent({
    initialState: {
      systemPrompt: "测试助手",
      model,
      tools: [createReadTool(process.cwd())],
      messages: [],
    },
    streamFn: (m, c, o) => models.streamSimple(m, c, o),
  });
  agent.subscribe((event) => events.push(event.type));

  await agent.prompt("请读取 package.json");
  await agent.waitForIdle();

  const text = agent.state.messages
    .filter((m) => m.role === "assistant")
    .map((m) =>
      (m.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(""),
    )
    .join("");
  if (!text.includes("完成")) throw new Error(`未收到最终文本，实际: ${text}`);
  if (!events.includes("tool_execution_end"))
    throw new Error(`未触发工具执行，事件: ${events.join(",")}`);
  results.push(`    - 最终文本: ${text.slice(0, 30)}...`);
  results.push(`    - 事件序列: ${events.join(" → ")}`);
});

// 4. env api key 机制
await check("envApiKeyAuth 环境变量读取", () => {
  const auth = envApiKeyAuth("DeepSeek", ["DEEPSEEK_API_KEY"]);
  if (typeof auth.resolve !== "function") throw new Error("auth 缺少 resolve");
  results.push("    - envApiKeyAuth 可用");
});

console.log("=== 上游 API 冒烟结果 ===");
console.log(results.join("\n"));
console.log(failed ? "\n存在失败 ❌" : "\n全部通过 ✅");

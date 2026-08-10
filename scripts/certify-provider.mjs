import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAndValidate } from "../packages/coremind-config/dist/index.js";
import {
  ChatSession,
  CoreMindRuntime,
  defineTool,
} from "../packages/coremind-runtime/dist/index.js";
import {
  assertCertificationSucceeded,
  createCertificationEvidence,
} from "./provider-certification.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerId = process.env.COREMIND_CERT_PROVIDER ?? "alibaba-model-studio";
const model = process.env.COREMIND_CERT_MODEL ?? "qwen-plus";
const apiKeyEnv = process.env.COREMIND_CERT_API_KEY_ENV ?? "DASHSCOPE_API_KEY";
const testedAt = new Date().toISOString();
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const originalKey = process.env[apiKeyEnv];
if (!originalKey) throw new Error(`缺少认证密钥环境变量：${apiKeyEnv}`);

const details = {};
try {
  const basicEvents = [];
  const basic = await createRuntime({
    prompt: '只输出 JSON：{"status":"ok","marker":"CM-CERT-2026"}',
    events: (event) => basicEvents.push(event),
  });
  const basicResult = await basic.run();
  assertCertificationSucceeded(basicResult, "流式与结构化结果");
  const structured = parseJsonObject(basicResult.transcript);
  if (structured.status !== "ok" || structured.marker !== "CM-CERT-2026") {
    throw new Error("结构化结果字段不符合预期");
  }
  const deltaCount = basicEvents.filter((event) => event.type === "text_delta").length;
  if (deltaCount < 1) throw new Error("没有收到流式文本事件");
  details.streaming = { passed: true, deltaCount };
  details.structuredResult = { passed: true, outputHash: hash(basicResult.transcript) };

  const tool = defineTool({
    name: "lookup_certification_marker",
    description: "返回认证标记。必须先调用此工具，不能自行猜测标记。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    effect: { operations: ["read"], reversible: true },
    execute: () => ({ text: "TOOL-CERT-4271" }),
  });
  const toolEvents = [];
  const toolRuntime = await createRuntime({
    prompt: "请调用 lookup_certification_marker 工具，并原样输出工具返回的标记。",
    events: (event) => toolEvents.push(event),
    toolDefinitions: [tool],
  });
  const toolResult = await toolRuntime.run();
  assertCertificationSucceeded(toolResult, "工具调用");
  const called = toolEvents.some(
    (event) => event.type === "tool_call" && event.tool === "lookup_certification_marker",
  );
  const returned = toolEvents.some(
    (event) => event.type === "tool_result" && event.tool === "lookup_certification_marker",
  );
  if (!called || !returned || !toolResult.transcript.includes("TOOL-CERT-4271")) {
    throw new Error("工具调用链不完整");
  }
  details.toolCall = { passed: true, calls: toolResult.metrics.toolCalls };

  const chatRuntime = await createRuntime({});
  const session = new ChatSession(chatRuntime, "assistant");
  const firstTurn = await session.chat("记住合成测试代码 SESSION-CERT-8319，只回复已记住。");
  const secondTurn = await session.chat("我刚才要求你记住的代码是什么？只回复代码。");
  const thirdTurn = await session.chat("请再次只回复刚才的合成测试代码。");
  assertCertificationSucceeded(firstTurn.run, "多轮第一轮");
  assertCertificationSucceeded(secondTurn.run, "多轮第二轮");
  assertCertificationSucceeded(thirdTurn.run, "多轮第三轮");
  if (
    !secondTurn.text.includes("SESSION-CERT-8319") ||
    !thirdTurn.text.includes("SESSION-CERT-8319")
  ) {
    throw new Error("多轮上下文未保持");
  }
  details.multiTurn = { passed: true, turns: 3, outputHash: hash(thirdTurn.text) };

  process.env[apiKeyEnv] = "invalid-coremind-certification-key";
  const errorRuntime = await createRuntime({ prompt: "只回复 ERROR-CHECK" });
  try {
    const errorResult = await errorRuntime.run();
    if (errorResult.outcome.status === "succeeded") throw new Error("无效密钥被错误标记为成功");
    const serialized = JSON.stringify(errorResult);
    if (serialized.includes("invalid-coremind-certification-key")) {
      throw new Error("错误结果泄露了测试密钥");
    }
    details.error = { passed: true, status: errorResult.outcome.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("invalid-coremind-certification-key")) {
      throw new Error("错误异常泄露了测试密钥");
    }
    if (!/401|invalid.api.key/i.test(message)) throw error;
    details.error = { passed: true, status: "rejected", diagnostic: "authentication_error" };
  }
} finally {
  process.env[apiKeyEnv] = originalKey;
}

const evidence = createCertificationEvidence({
  provider: providerId,
  model,
  version,
  testedAt,
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  details,
});
const date = testedAt.slice(0, 10);
const output = path.join(root, "docs", "providers", "evidence", `${providerId}-${date}.json`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`Provider 真实认证通过：${providerId}/${model}，证据：${path.relative(root, output)}`);

async function createRuntime({ prompt, events, toolDefinitions } = {}) {
  const { config } = parseAndValidate({
    schemaVersion: 2,
    name: "provider-certification",
    provider: { id: providerId, model, apiKeyEnv },
    agents: {
      assistant: {
        systemPrompt: "你正在执行自动化认证，只处理合成标记，不要求或输出任何其他数据。",
      },
    },
    permissions: { mode: "full" },
    runtime: { maxTurns: 6, maxSteps: 8, maxToolCalls: 2, runTimeoutMs: 120000 },
  });
  return CoreMindRuntime.create({
    config,
    configDir: root,
    initialPrompt: prompt,
    events,
    toolDefinitions,
    env: process.env,
  });
}

function parseJsonObject(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("没有找到 JSON 对象");
  return JSON.parse(match[0]);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

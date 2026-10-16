import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AssistantMessage,
  createModels,
  createProvider,
  type Model,
  Type,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { CoreMindSession } from "./session.js";
import { convertToLlm } from "./session-v4/index.js";

const THINKING = "SIGNED_HISTORY_THINKING";
const SIGNATURE = "opaque-signed-history-fixture";
const ANSWER = "SIGNED_HISTORY_VISIBLE_ANSWER";
const CALL_ID = "call_history_1";
interface Payload {
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
}

// 该测试只验真实请求序列化视图；onPayload 后取消，并用 fetch 拒绝桩保证零出站。
it.for([
  ["同模型保留签名", "signature-probe", "old-model", true],
  ["换模型保留工具配对", "signature-probe", "new-model", false],
  ["换 Provider 保留工具配对", "signature-probe-new", "old-model", false],
] as const)("%s 且不改写持久会话", async ([_name, provider, id, keepThinking], context) => {
  const parent = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(parent, "coremind-signed-history-"));
  const controller = new AbortController();
  const fetch = vi.fn(async () => {
    throw new Error("请求视图验收不得出站");
  });
  const options = {
    dir: path.join(directory, "sessions"),
    sessionId: "signed-history",
    cwd: directory,
  };
  try {
    const assistant: AssistantMessage = {
      role: "assistant",
      api: "anthropic-messages",
      provider: "signature-probe",
      model: "old-model",
      content: [
        { type: "thinking", thinking: THINKING, thinkingSignature: SIGNATURE },
        { type: "text", text: ANSWER },
        { type: "toolCall", id: CALL_ID, name: "read", arguments: { path: "archive.md" } },
      ],
      stopReason: "toolUse",
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: CALL_ID,
      toolName: "read",
      isError: false,
      timestamp: 3,
      content: [{ type: "text" as const, text: "HISTORICAL_READ_RESULT" }],
    };
    const stored = await CoreMindSession.open(options);
    await stored.appendMessages([
      { role: "user", content: "历史问题", timestamp: 1 },
      assistant,
      toolResult,
      { role: "user", content: "继续", timestamp: 4 },
    ]);
    const prefix = readFileSync(stored.filePath);
    const reopened = await CoreMindSession.open(options);
    const restored = (await reopened.buildContext()).messages;
    const original = JSON.stringify(restored);
    expect(original).toContain(SIGNATURE);
    expect(original).toContain(CALL_ID);
    const model: Model<"anthropic-messages"> = {
      id,
      name: id,
      api: "anthropic-messages",
      provider,
      baseUrl: "http://127.0.0.1:9",
      reasoning: true,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const models = createModels();
    models.setProvider(
      createProvider({
        id: provider,
        models: [model],
        api: anthropicMessagesApi(),
        auth: {
          apiKey: { name: "测试凭据", resolve: async () => ({ auth: { apiKey: "fixture-only" } }) },
        },
      }),
    );
    let payload: Payload | undefined;
    await models
      .completeSimple(
        model,
        {
          messages: convertToLlm(restored),
          tools: [
            {
              name: "read",
              description: "历史读取工具",
              parameters: Type.Object({ path: Type.String() }),
            },
          ],
        },
        {
          reasoning: "low",
          maxTokens: 2048,
          fetch,
          signal: AbortSignal.any([controller.signal, context.signal]),
          onPayload: (value) => {
            payload = value as Payload;
            controller.abort();
            return value;
          },
        },
      )
      .catch(() => undefined);
    expect(payload?.messages).toBeInstanceOf(Array);
    expect(fetch).not.toHaveBeenCalled();
    const blocks = payload!.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    );
    const signed = blocks.filter((block) => block.type === "thinking");
    if (keepThinking) expect(signed).toMatchObject([{ thinking: THINKING, signature: SIGNATURE }]);
    else {
      expect(signed).toEqual([]);
      expect(JSON.stringify(payload)).not.toContain(THINKING);
      expect(JSON.stringify(payload)).not.toContain(SIGNATURE);
    }
    expect(JSON.stringify(payload)).toContain(ANSWER);
    const uses = blocks.filter((block) => block.type === "tool_use");
    const results = blocks.filter((block) => block.type === "tool_result");
    expect(uses).toMatchObject([{ id: CALL_ID, name: "read", input: { path: "archive.md" } }]);
    expect(results).toMatchObject([{ tool_use_id: CALL_ID, is_error: false }]);
    expect(JSON.stringify(results)).toContain("HISTORICAL_READ_RESULT");
    expect(JSON.stringify(restored)).toBe(original);
    expect(readFileSync(stored.filePath)).toEqual(prefix);
  } finally {
    controller.abort();
    expect(path.dirname(path.resolve(directory))).toBe(parent);
    expect(path.basename(directory).startsWith("coremind-signed-history-")).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

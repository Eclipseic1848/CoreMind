import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const toolName = "record_dispatch";
export const input = { orderId: "SHIP-A100" };
export const inputSchema = {
  type: "object",
  properties: { orderId: { type: "string" } },
  required: ["orderId"],
  additionalProperties: false,
};
export const outputSchema = {
  type: "object",
  properties: { orderId: { type: "string" }, receiptId: { type: "string", minLength: 1 } },
  required: ["orderId", "receiptId"],
  additionalProperties: false,
};

export function writeReceipt(recordPath, mode, { orderId }) {
  const receipt = { orderId, receiptId: `ledger:${orderId}` };
  // 账本先确认写入，然后在返回业务回执的边界注入故障。
  appendFileSync(recordPath, `${JSON.stringify(receipt)}\n`, "utf8");
  if (mode === "missing") return { orderId };
  if (mode === "invalid") return { orderId, receiptId: 42 };
  if (mode === "lost") return undefined;
  return receipt;
}

export function mcpReply(recordPath, mode, message) {
  if (message.id === undefined) return null;
  let result;
  switch (message.method) {
    case "server/discover":
      result = {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        ttlMs: 0,
        cacheScope: "private",
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: toolName,
            description: "登记合成订单发运并返回账本回执",
            inputSchema,
            outputSchema,
          },
        ],
        ttlMs: 0,
        cacheScope: "private",
      };
      break;
    case "tools/call": {
      if (message.params?.name !== toolName) throw new Error("调用了未知的发运工具");
      const receipt = writeReceipt(recordPath, mode, message.params.arguments);
      if (receipt === undefined) return undefined;
      result = {
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        structuredContent: receipt,
      };
      break;
    }
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "未知夹具方法" } };
  }
  return { jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ...result } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [recordPath, mode] = process.argv.slice(2);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const response = mcpReply(recordPath, mode, JSON.parse(line));
    if (response === undefined) process.exit(0);
    if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

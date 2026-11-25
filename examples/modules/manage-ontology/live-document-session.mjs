import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ChatSession, CoreMindRuntime, loadConfigFile, parseAndValidate } from "coremind-ai";

const [file, prompt] = process.argv.slice(2);
if (!file || !prompt) throw new Error("用法：node live-document-session.mjs <配置路径> <任务>");
const { config } = parseAndValidate(await loadConfigFile(file));
const cwd = path.dirname(path.resolve(file));
const sessionId = randomUUID();
const runtime = await CoreMindRuntime.create({
  config,
  configDir: cwd,
  cwd,
  sessionId,
  approveTool: async ({ tool, args }) =>
    tool === "write" && args?.path === "summary.md" ? "allow" : "deny",
});
const chat = new ChatSession(runtime, config.defaultAgent);
const { run, events } = await chat.chat(prompt);
assert.equal(run.outcome.status, "succeeded", JSON.stringify(run.outcome));
assert.equal((await chat.inspectSessionTree()).sessionId, sessionId);
const calls = events.filter((event) => event.type === "tool_call");
const finished = new Map(
  events.filter((event) => event.type === "tool_result").map((event) => [event.callId, event]),
);
const tools = calls.map(({ callId, tool, args }) => ({
  name: args?.mcp?.tool ?? tool,
  succeeded: finished.get(callId)?.isError === false,
}));
console.log(JSON.stringify({ sessionId, runId: run.runId, tools, text: run.transcript }));

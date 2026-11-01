import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateConfig } from "../../packages/coremind-config/dist/index.js";
import { FileRunStore, TaskSession } from "../../packages/coremind-runtime/dist/index.js";
import { TaskCommitSession } from "../../packages/coremind-runtime/dist/internal.js";

const [workspace, scenario, point] = process.argv.slice(2);
const marker = path.join(workspace, "attempts.txt");
const effect = path.join(workspace, "effect.txt");
const commit = TaskCommitSession.prototype.commit;
TaskCommitSession.prototype.commit = async function (input) {
  const call = input.task?.checkpoint?.callGroups?.at(-1)?.calls?.at(-1);
  if (point === "projection" && call?.status === "completed") process.exit(23);
  const receipt = await commit.call(this, input);
  if (point === "intent" && call?.status === "pending") process.exit(23);
  return receipt;
};
const runtime = {
  authorityVersion: scenario,
  configDir: workspace,
  env: { COREMIND_TEST_API_KEY: "test-only" },
  config: validateConfig({
    schemaVersion: 2,
    name: "真实进程稳定键恢复",
    defaultAgent: "main",
    provider: {
      id: "local-probe",
      model: "probe",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
      baseUrl: "http://127.0.0.1:1/v1",
    },
    agents: { main: {} },
    runtime: { maxRetries: 0, runTimeoutMs: 5_000 },
    permissions: { mode: "ask", workspaceOnly: false, network: "allow" },
  }),
  approveTool: async () => {
    return "allow";
  },
  toolDefinitions: [
    {
      name: "effect",
      description: "具有可检查逻辑效果的本地夹具",
      parameters: {
        type: "object",
        properties: { request: { type: "string" } },
        required: ["request"],
        additionalProperties: false,
      },
      effect: { operations: ["external"], reversible: false },
      capability: {
        effect: "external",
        replay: scenario,
        concurrency: "run_serial",
        checkpoint: "unsupported",
        durability: "critical",
      },
      execute: async (_args, context) => {
        appendFileSync(marker, `${context.callId}\n`, "utf8");
        // 夹具的幂等性由固定 request 对应的效果文件实现；不能类推到任意外部服务。
        if (!existsSync(effect)) writeFileSync(effect, "once", "utf8");
        if (point === "effect") process.exit(23);
        return { text: "结果", details: { effect: readFileSync(effect, "utf8") } };
      },
    },
  ],
};
const session = await TaskSession.open({
  workspace,
  sessionId: "calls",
  runtime,
  definitions: [
    {
      type: "calls",
      version: 1,
      initialPhase: "a",
      checkpointSchema: { type: "string" },
      phases: {
        async a(context) {
          const value = await context.runCalls(async ({ executeTool }) => {
            const result = await executeTool("one", "effect", { request: "fixed" });
            if (point === "result") process.exit(23);
            return JSON.stringify(result);
          });
          if (point === "run-finished") process.exit(23);
          return { phase: "a", checkpoint: value, done: true };
        },
      },
    },
  ],
});
if (!session.query("job"))
  await session.start({ taskId: "job", type: "calls", checkpoint: "initial" });
let error;
try {
  await session.resume("job");
} catch (caught) {
  error = { code: caught.code, message: caught.message };
}
const calls = session.calls("job");
const facts = calls.length
  ? await new FileRunStore(path.join(workspace, ".coremind/runs")).read(calls[0].runId)
  : [];
process.stdout.write(
  JSON.stringify({
    task: session.query("job"),
    calls,
    error,
    facts,
    attempts: existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [],
    effect: existsSync(effect) ? readFileSync(effect, "utf8") : null,
  }),
);
await session.close();

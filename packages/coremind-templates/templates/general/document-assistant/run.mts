import path from "node:path";
import { CoreMindRuntime, loadConfigFile, parseAndValidate } from "coremind-ai";

const [file, initialPrompt] = process.argv.slice(2);
if (!file || !initialPrompt) throw new Error("用法：node run.mts <配置文件> <任务>");
const project = path.dirname(path.resolve(file));
const { config } = parseAndValidate(await loadConfigFile(file));
const runtime = await CoreMindRuntime.create({
  config,
  configDir: project,
  cwd: project,
  initialPrompt,
  approveTool: async ({ tool, args }) =>
    tool === "write" &&
    typeof args === "object" &&
    args !== null &&
    "path" in args &&
    args.path === "summary.md"
      ? "allow"
      : "deny",
});
const result = await runtime.run();
if (result.outcome.status !== "succeeded") throw new Error(JSON.stringify(result.outcome));
console.log(result.transcript);

import path from "node:path";
import { CoreMindRuntime, loadConfigFile, parseAndValidate } from "coremind-ai";

const [configFile, initialPrompt] = process.argv.slice(2);
if (!configFile || !initialPrompt) throw new Error("请提供配置路径和任务提示");
const { config } = parseAndValidate(await loadConfigFile(configFile));
const runtime = await CoreMindRuntime.create({
  config,
  configDir: path.dirname(path.resolve(configFile)),
  initialPrompt,
});
const result = await runtime.run();
if (result.outcome.status !== "succeeded") throw new Error(JSON.stringify(result.outcome));
console.log(result.transcript);

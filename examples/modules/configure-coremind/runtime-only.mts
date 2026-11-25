import { dirname, resolve } from "node:path";
import { CoreMindRuntime, loadConfigFile, parseAndValidate } from "coremind-ai";

const file = resolve("coremind.yaml");
const { config } = parseAndValidate(await loadConfigFile(file));
const runtime = await CoreMindRuntime.create({
  config,
  configDir: dirname(file),
  initialPrompt: process.argv[2] ?? "请只回答 OK",
});
const result = await runtime.run();
if (result.outcome.status !== "succeeded") throw new Error(JSON.stringify(result.outcome));
console.log(result.transcript);

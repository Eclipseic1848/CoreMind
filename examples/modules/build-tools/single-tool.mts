import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CoreMindRuntime, defineTool, loadConfigFile, parseAndValidate } from "coremind-ai";

const [implementation, prompt = "查询编号 A-100"] = process.argv.slice(2);
const file = resolve("coremind.yaml");
const { config } = parseAndValidate(await loadConfigFile(file));
const toolDefinitions = implementation
  ? [
      defineTool({
        name: "lookup_order",
        description: "按编号查询订单状态，返回业务回执",
        parameters: {
          type: "object",
          properties: { id: { type: "string", pattern: "^A-[0-9]+$" } },
          required: ["id"],
          additionalProperties: false,
        },
        effect: { operations: ["read"], reversible: true },
        execute: (await import(pathToFileURL(resolve(implementation)).href)).lookupOrder,
      }),
    ]
  : [];
const runtime = await CoreMindRuntime.create({
  config,
  configDir: dirname(file),
  initialPrompt: prompt,
  toolDefinitions,
});
const result = await runtime.run();
console.log(JSON.stringify({ status: result.outcome.status, transcript: result.transcript }));
if (result.outcome.status !== "succeeded") process.exitCode = 1;

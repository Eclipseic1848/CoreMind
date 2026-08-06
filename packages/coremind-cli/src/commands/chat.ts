import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { CoreMindRuntime } from "coremind-ai";
import { type CoreMindConfig, loadConfigFile, parseAndValidate } from "coremind-config";
import { flagBool, type ParsedArgs } from "../args.js";
import { cyan, dim, errorLine, yellow } from "../render.js";

/**
 * coremind chat <file>：交互式对话（复用同一 agent 实例，保持多轮上下文）。
 * 输入 !exit 退出、!abort 中止当前轮。
 */
export async function cmdChat(parsed: ParsedArgs, positionals: string[]): Promise<number> {
  const file = positionals[0];
  if (!file) {
    console.error(errorLine("请指定配置文件路径，如：coremind chat coremind.yaml"));
    return 1;
  }

  let data: unknown;
  try {
    data = await loadConfigFile(file);
  } catch (error) {
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  let config: CoreMindConfig;
  try {
    const result = parseAndValidate(data);
    config = result.config;
    for (const warning of result.warnings) console.warn(yellow(`⚠ ${warning}`));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const configDir = path.dirname(path.resolve(file));
  const runtime = await CoreMindRuntime.create({
    config,
    configDir,
    cwd: process.cwd(),
    events: (event) => {
      if (event.type === "text_delta") process.stdout.write(event.delta);
      else if (event.type === "error" && !event.fatal) console.warn(yellow(`⚠ ${event.message}`));
    },
  });

  const agentName = config.defaultAgent ?? Object.keys(config.agents)[0];
  const agent = runtime.createAgent(agentName ?? "");
  if (!agent) {
    console.error(errorLine("配置中没有可用的 agent"));
    return 1;
  }

  const quiet = flagBool(parsed, "quiet");
  if (!quiet) console.log(dim(`开始对话（Ctrl+C 退出，输入 !exit 退出）—— ${config.name}`));

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const line = await rl.question(cyan("\n你 > "));
      const text = line.trim();
      if (text === "") continue;
      if (text === "!exit") break;
      if (text === "!abort") {
        agent.abort();
        continue;
      }
      process.stdout.write(`${dim("[assistant] ")}`);
      await agent.prompt(text);
      await agent.waitForIdle();
      process.stdout.write("\n");
    }
  } finally {
    rl.close();
  }
  return 0;
}

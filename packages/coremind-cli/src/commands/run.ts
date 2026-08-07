import path from "node:path";
import { CoreMindRuntime } from "coremind-ai";
import { type CoreMindConfig, loadConfigFile, parseAndValidate } from "coremind-config";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../args.js";
import { cyan, dim, errorLine, stepLine, toolLine, toolResultLine, yellow } from "../render.js";

/**
 * coremind run <file>：校验配置 → 构建运行时 → 执行。
 * 支持 --prompt / --print / --json-events / --session（保存会话） / --max-steps。
 */
export async function cmdRun(parsed: ParsedArgs, positionals: string[]): Promise<number> {
  const file = positionals[0];
  if (!file) {
    console.error(errorLine("请指定配置文件路径，如：coremind run coremind.yaml"));
    return 1;
  }

  // 1. 读取并校验配置
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

  const printOnly = flagBool(parsed, "print");
  const jsonEvents = flagBool(parsed, "json-events");
  const initialPrompt = flagString(parsed, "prompt") ?? flagString(parsed, "p");
  const sessionId = flagString(parsed, "session");
  const maxSteps = flagNumber(parsed, "max-steps");
  const configDir = path.dirname(path.resolve(file));

  // 2. 构建运行时（事件回调：JSONL 或渲染）
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  const runtime = await CoreMindRuntime.create({
    config,
    configDir,
    cwd: process.cwd(),
    initialPrompt,
    sessionId,
    maxSteps,
    signal: controller.signal,
    events: (event) => {
      if (jsonEvents) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        return;
      }
      if (printOnly && event.type === "text_delta") return;
      renderEvent(event);
    },
  });
  if (runtime.resumedContextLength > 0) {
    console.log(dim(`已恢复会话 ${sessionId}（${runtime.resumedContextLength} 条历史消息）`));
  }

  // 3. 执行
  try {
    const result = await runtime.run();
    if (printOnly && result.transcript.length > 0) {
      process.stdout.write(
        result.transcript.endsWith("\n") ? result.transcript : `${result.transcript}\n`,
      );
    }
    if (result.sessionFile) {
      console.log(dim(`会话已保存：${result.sessionFile}`));
    }
    return 0;
  } catch (error) {
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/** 默认模式的事件渲染（流式文本 + 步骤 + 工具调用） */
function renderEvent(
  event: Parameters<NonNullable<Parameters<typeof CoreMindRuntime.create>[0]["events"]>>[0],
): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "step_start":
      process.stdout.write(`\n${stepLine(event.stepId, event.kind)}\n`);
      break;
    case "tool_call":
      process.stdout.write(`\n${toolLine(event.tool, event.args)}`);
      break;
    case "tool_result":
      process.stdout.write(toolResultLine(event.isError));
      break;
    case "agent_start":
      process.stdout.write(`\n${cyan(`[${event.agent}]`)} `);
      break;
    case "agent_end":
      process.stdout.write("\n");
      break;
    case "error":
      if (event.fatal) {
        console.error(errorLine(event.message));
      } else {
        console.warn(yellow(`⚠ ${event.message}`));
      }
      break;
  }
}

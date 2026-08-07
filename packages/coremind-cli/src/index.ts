import { createRequire } from "node:module";
import { type ParsedArgs, parseArgs } from "./args.js";

// 版本单一来源：cli 包 package.json（构建后 dist/ 与 package.json 同级）
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

import { cmdChat } from "./commands/chat.js";
import { cmdCreate } from "./commands/create.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdListTemplates } from "./commands/list-templates.js";
import { cmdRun } from "./commands/run.js";
import { cyan, dim, red } from "./render.js";

/** CLI 主入口：解析参数 → 分发命令 → 返回退出码 */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const [command, ...rest] = parsed.positionals;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return command === undefined || command === "help" ? 0 : 0;
  }

  switch (command) {
    case "create":
      return cmdCreate(parsed, rest);
    case "run":
      return cmdRun(parsed, rest);
    case "chat":
      return cmdChat(parsed, rest);
    case "list-templates":
      return cmdListTemplates();
    case "doctor":
      return cmdDoctor(parsed, rest);
    default:
      console.error(red(`未知命令：${command}`));
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  console.log(`
${cyan("CoreMind（星枢智核）")} — 配置驱动智能体开发框架 ${dim(`v${version}`)}

用法：coremind <命令> [参数]

命令：
  ${cyan("create <name>")}          从模板创建新项目（--template <id> 非交互）
  ${cyan("run <file>")}             运行智能体配置
      --prompt "..."    首条输入（单 agent 模式必填；workflow 注册为 {{prompt}}）
      --print           只输出最终文本（适合管道/脚本）
      --json-events     输出 JSONL 事件流（供外部集成/Web 面板）
      --session <id>    保存会话（断点续聊恢复二期提供）
      --max-steps <n>   工作流总步骤上限（默认 100）
  ${cyan("chat <file>")}            交互式对话（多轮上下文）
  ${cyan("list-templates")}         列出场景模板
  ${cyan("doctor [file]")}          环境自检

示例：
  ${dim("coremind create my-agent --template translator")}
  ${dim('coremind run my-agent/coremind.yaml --prompt "翻译：你好，世界"')}
`);
}

export type { ParsedArgs };

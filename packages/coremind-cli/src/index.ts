// 启动时自动加载 cwd 下的 .env（dotenv 默认不覆盖已有环境变量）：
// 新手流程「copy .env.example .env 并填入 key」由此生效
import "dotenv/config";
import { createRequire } from "node:module";
import { type ParsedArgs, parseArgs } from "./args.js";

// 版本单一来源：cli 包 package.json（构建后 dist/ 与 package.json 同级）
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

import { cyan, dim, red } from "./render.js";

/** CLI 主入口：解析参数 → 分发命令 → 返回退出码 */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const [command, ...rest] = parsed.positionals;

  if (parsed.flags.has("version") || parsed.flags.has("v")) {
    console.log(`coremind v${version}`);
    return 0;
  }

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return command === undefined || command === "help" ? 0 : 0;
  }

  switch (command) {
    case "create":
      return (await import("./commands/create.js")).cmdCreate(parsed, rest);
    case "run":
      return (await import("./commands/run.js")).cmdRun(parsed, rest);
    case "chat":
      return (await import("./commands/chat.js")).cmdChat(parsed, rest);
    case "check":
      return (await import("./commands/check.js")).cmdCheck(parsed, rest);
    case "eval":
      return (await import("./commands/eval.js")).cmdEval(parsed, rest);
    case "templates":
    case "list-templates":
      return (await import("./commands/list-templates.js")).cmdListTemplates();
    case "doctor":
      return (await import("./commands/doctor.js")).cmdDoctor(parsed, rest);
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
  ${cyan("create <name>")}          创建新项目或接入已有工程
      --template <id>   非交互选择模板
      --language <lang> typescript、javascript 或 python
  ${cyan("run <file>")}             运行智能体配置
      --prompt "..."    首条输入（单 agent 模式必填；workflow 注册为 {{prompt}}）
      --print           只输出最终文本（适合管道/脚本）
      --json-events     输出 JSONL 事件流（供外部集成/Web 面板）
      --session <id>    保存并恢复会话
      --resume <runId>  从意外中断或显式暂停运行的稳定边界继续
      --max-steps <n>   工作流总步骤上限（默认 100）
      --permission <m>  临时选择 ask、assisted 或 full
  ${cyan("chat <file>")}            交互式对话（多轮上下文）
  ${cyan("check [file]")}           配置、安全、项目材料与质量门禁
      --profile <level> development、standard 或 strict
      --override-reason  覆盖非安全门禁并留痕
  ${cyan("eval [file]")}            运行场景评测（--suite <file>，TTY 可审批）
  ${cyan("templates")}              列出场景模板（兼容 list-templates）
  ${cyan("doctor [file]")}          环境自检

示例：
  ${dim("coremind create my-agent --template translator")}
  ${dim('coremind run my-agent/coremind.yaml --prompt "翻译：你好，世界"')}
`);
}

export type { ParsedArgs };

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

/** 单选菜单：返回选中项下标（取消返回 -1） */
export async function select(
  prompt: string,
  options: { label: string; description?: string }[],
): Promise<number> {
  if (options.length === 0) return -1;
  if (options.length === 1) {
    console.log(`${prompt} ${options[0]?.label}`);
    return 0;
  }
  const rl = createInterface({ input, output });
  console.log(prompt);
  options.forEach((opt, i) => {
    const desc = opt.description ? ` — ${opt.description}` : "";
    console.log(`  ${i + 1}. ${opt.label}${desc}`);
  });
  let index = -1;
  while (index < 0) {
    const answer = await rl.question("请选择序号（回车取消）：");
    const num = Number.parseInt(answer.trim(), 10);
    if (answer.trim() === "") break;
    if (num >= 1 && num <= options.length) {
      index = num - 1;
      break;
    }
    console.log("无效序号，请重试。");
  }
  rl.close();
  return index;
}

/** 单行输入（空值返回 undefined） */
export async function promptLine(prompt: string): Promise<string | undefined> {
  const rl = createInterface({ input, output });
  const answer = await rl.question(prompt);
  rl.close();
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

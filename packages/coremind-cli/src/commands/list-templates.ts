import { TEMPLATES } from "coremind-ai";
import { cyan, dim } from "../render.js";

const CATEGORY_NAMES: Record<string, string> = {
  general: "通用任务",
  coding: "编程辅助",
  industry: "垂直行业",
  workflow: "工作流",
};

/** coremind list-templates：按分类打印模板清单 */
export async function cmdListTemplates(): Promise<number> {
  console.log("CoreMind 场景模板：\n");
  for (const category of ["general", "coding", "industry", "workflow"]) {
    const items = TEMPLATES.filter((t) => t.category === category);
    if (items.length === 0) continue;
    console.log(`${cyan(CATEGORY_NAMES[category] ?? category)}`);
    for (const t of items) {
      const env = t.requiresEnv.length > 0 ? dim(`  需要：${t.requiresEnv.join("、")}`) : "";
      console.log(`  ${t.id.padEnd(20)} ${t.name}${env}`);
      console.log(`  ${"".padEnd(20)} ${dim(t.description)}`);
    }
    console.log("");
  }
  console.log(
    `共 ${TEMPLATES.length} 个模板。创建：${cyan("coremind create <name> --template <id>")}`,
  );
  return 0;
}

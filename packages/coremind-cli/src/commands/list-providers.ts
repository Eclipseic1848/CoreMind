import { listSupportedProviders } from "coremind-ai";
import { cyan, dim } from "../render.js";

export const PROVIDER_CERTIFICATION_URL =
  "https://eclipseic1848.github.io/CoreMind/providers/README.zh-CN.html";

/** 可配置入口来自 Runtime，发布认证由对应版本的矩阵提供。 */
export async function cmdListProviders(): Promise<number> {
  console.log("CoreMind Provider：\n");
  for (const id of listSupportedProviders().sort((left, right) =>
    left.localeCompare(right, "en"),
  )) {
    console.log(`  ${cyan(id)}`);
  }
  console.log(dim(`\n可配置入口的版本认证：${PROVIDER_CERTIFICATION_URL}`));
  console.log("\n创建项目时使用：coremind create <name> --provider <id>");
  return 0;
}

import { listSupportedProviders } from "coremind-ai";
import { cyan, dim } from "../render.js";

const CERTIFIED_PROVIDER_IDS = new Set(["alibaba-model-studio"]);

/** 返回当前 CLI 版本随附的认证状态；发布前必须由真实认证证据复核。 */
export function providerStatusLabel(id: string): string {
  return CERTIFIED_PROVIDER_IDS.has(id) ? "CoreMind 已认证" : "可配置，尚未认证";
}

/** 列出可配置入口；只有存在完整公开证据的入口标记为已认证。 */
export async function cmdListProviders(): Promise<number> {
  console.log("CoreMind Provider：\n");
  for (const id of listSupportedProviders().sort((left, right) =>
    left.localeCompare(right, "en"),
  )) {
    console.log(`  ${cyan(id.padEnd(28))} ${dim(providerStatusLabel(id))}`);
  }
  console.log("\n创建项目时使用：coremind create <name> --provider <id>");
  return 0;
}

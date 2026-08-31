import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProviderRuntime,
  listSupportedProviders,
} from "../packages/coremind-runtime/dist/provider.js";
import { buildProviderMatrix } from "./provider-matrix-lib.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "docs", "providers");
const certificationsPath = path.join(outputDirectory, "certifications.json");

const ledger = JSON.parse(await readFile(certificationsPath, "utf8"));
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const providers = [];
for (const id of listSupportedProviders()) {
  // 这里只读取锁定的静态模型目录；显式测试引用避免目录生成器依赖真实凭据。
  const runtime = await buildProviderRuntime(
    { id, apiKeySecretRef: { secretRef: `matrix/${id}` } },
    {},
    { resolve: async () => "matrix-only" },
  );
  providers.push({
    id,
    defaultModel: runtime.model.id,
    modelCount: runtime.models.getModels(id).length,
  });
}

const matrix = buildProviderMatrix({
  providers,
  certifications: ledger.certifications,
  generatedAt: ledger.updatedAt,
  targetVersion: rootManifest.version,
});

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(
    path.join(outputDirectory, "matrix.json"),
    `${JSON.stringify(matrix, null, 2)}\n`,
    "utf8",
  ),
  writeFile(path.join(outputDirectory, "README.zh-CN.md"), renderChinese(matrix), "utf8"),
  writeFile(path.join(outputDirectory, "README.en.md"), renderEnglish(matrix), "utf8"),
]);
console.log(
  `Provider 矩阵已生成：可配置 ${matrix.summary.supported}，认证 ${matrix.summary.certified}，待验证 ${matrix.summary.unverified}。`,
);

function renderChinese(data) {
  const rows = data.providers.map((item) => {
    const previous = item.previousCertification;
    const version = item.testedVersion ?? previous?.version;
    const evidence = item.evidence ?? previous?.evidence;
    const status =
      item.status === "certified"
        ? "已认证"
        : previous
          ? `可配置，${data.targetVersion} 未认证（保留旧版证据）`
          : item.certificationGap?.length
            ? `可配置，未完成当前认证（缺 ${item.certificationGap.join("、")}）`
            : "可配置，未认证";
    return `| \`${item.id}\` | \`${item.defaultModel}\` | ${version ? `\`${version}\`` : "—"} | ${item.modelCount} | ${status} | ${evidence ? `[证据](${evidence})` : "—"} |`;
  });
  return `# Provider 支持与认证矩阵

> 生成日期：${data.generatedAt}；当前候选：\`${data.targetVersion}\`。本页由运行时静态目录和人工证据台账生成，不应手工改表格。

CoreMind 当前可配置 **${data.summary.supported}** 个内置 Provider，其中 **${data.summary.certified}** 个具有完整真实调用证据，**${data.summary.unverified}** 个仅代表运行时目录可识别。**可配置不等于通过真实认证。**

## 状态定义

- **已认证**：同一模型完成真实流式输出、工具调用、结构化结果、多轮会话、中止、错误映射、长上下文与父子 Agent 产品链检查，并保存可审计证据。
- **可配置，未认证**：配置和模型目录可解析，但当前候选尚无完整真实调用证据；旧版证据只用于追溯。
- **可配置，未完成当前认证**：保留旧版证据，但缺少当前强制检查中的一项或多项，不计入已认证。
- 自定义 OpenAI 兼容端点不进入静态认证表，必须由项目针对实际部署单独验收。

## 当前矩阵

| Provider ID | 默认模型 | 认证版本 | 模型数 | 状态 | 证据 |
|---|---|---|---:|---|---|
${rows.join("\n")}

## 如何新增认证

请严格按照 [Provider 认证 SOP](CERTIFICATION.zh-CN.md) 执行。认证记录只能写入 \`certifications.json\`，随后运行 \`npm run providers:matrix\` 生成本页。没有真实密钥、运行日志和错误场景证据时，不得把状态改为“已认证”。
`;
}

function renderEnglish(data) {
  const rows = data.providers.map((item) => {
    const previous = item.previousCertification;
    const version = item.testedVersion ?? previous?.version;
    const evidence = item.evidence ?? previous?.evidence;
    const status =
      item.status === "certified"
        ? "Certified"
        : previous
          ? `Configurable, ${data.targetVersion} unverified (older evidence retained)`
          : item.certificationGap?.length
            ? `Configurable, incomplete current certification (missing ${item.certificationGap.join(", ")})`
            : "Configurable, unverified";
    return `| \`${item.id}\` | \`${item.defaultModel}\` | ${version ? `\`${version}\`` : "—"} | ${item.modelCount} | ${status} | ${evidence ? `[Evidence](${evidence})` : "—"} |`;
  });
  return `# Provider Support and Certification Matrix

> Generated on ${data.generatedAt} for candidate \`${data.targetVersion}\` from the static runtime catalog and the human-maintained evidence ledger. Do not edit the table manually.

CoreMind currently supports configuration for **${data.summary.supported}** built-in providers. Complete real-call evidence exists for **${data.summary.certified}**, while **${data.summary.unverified}** are catalog-only. **Configurable does not mean certified.**

## Status definitions

- **Certified**: the same model passed real streaming, tool-call, structured-result, multi-turn, abort, error-mapping, long-context, and parent/child Agent product-chain checks with auditable evidence.
- **Configurable, unverified**: configuration and model catalog resolution work, but the current candidate lacks complete real-call evidence; older evidence is historical only.
- **Configurable, incomplete current certification**: earlier evidence is retained but does not cover every current required check.
- Custom OpenAI-compatible endpoints are deployment-specific and must be accepted by each project.

## Current matrix

| Provider ID | Default model | Certified version | Models | Status | Evidence |
|---|---|---|---:|---|---|
${rows.join("\n")}

## Adding a certification

Follow the [Provider certification SOP](CERTIFICATION.en.md). Add records only to \`certifications.json\`, then run \`npm run providers:matrix\`. Never mark a provider as certified without real credentials, run logs, and error-path evidence.
`;
}

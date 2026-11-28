import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProviderRuntime,
  listSupportedProviders,
} from "../packages/coremind-runtime/dist/provider.js";
import { buildProviderMatrix, readRuntimeDigest } from "./provider-matrix-lib.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "docs", "providers");
const certificationsPath = path.join(outputDirectory, "certifications.json");

const ledger = JSON.parse(await readFile(certificationsPath, "utf8"));
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const targetRuntimeDigest = await readRuntimeDigest(repositoryRoot);
if (!targetRuntimeDigest)
  throw new Error("缺少打包的 Runtime，请先运行 npm run build:python-worker");
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
    modelCount: runtime.models.getModels(runtime.model.provider).length,
    ...(runtime.model.provider === id ? {} : { aliasOf: runtime.model.provider }),
  });
}

const matrix = buildProviderMatrix({
  providers,
  certifications: ledger.certifications,
  generatedAt: ledger.updatedAt,
  targetVersion: rootManifest.version,
  targetRuntimeDigest,
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
          ? "可配置，当前构建未认证（保留已测制品证据）"
          : item.certificationGap?.length
            ? `可配置，未完成当前认证（缺 ${item.certificationGap.join("、")}）`
            : "可配置，未认证";
    return `| \`${item.id}\`${item.aliasOf ? `（\`${item.aliasOf}\` 的兼容别名）` : ""} | \`${item.defaultModel}\` | ${version ? `\`${version}\`` : "—"} | ${item.modelCount} | ${status} | ${evidence ? `[证据](${evidence})` : "—"} |`;
  });
  return `# Provider 支持与认证矩阵

> 模型来自当前源码锁定的目录。认证依据 ${data.generatedAt} 的证据台账，须与目标版本 \`${data.targetVersion}\` 和打包 Runtime 的 SHA-256 一致。本页由脚本生成。

CoreMind 当前有 **${data.providers.filter((item) => !item.aliasOf).length}** 个内置聊天 Provider，含兼容别名共 **${data.summary.supported}** 个可配置入口。其中 **${data.summary.certified}** 个入口具有匹配当前构建的完整真实调用证据，**${data.summary.unverified}** 个入口待认证。

## 状态定义

- **已认证**：同一模型完成真实流式输出、工具调用、结构化结果、多轮会话、中止、错误映射、长上下文与父子 Agent 产品链检查，并保存可审计证据。
- **可配置，未认证**：配置和模型目录可解析，但当前版本尚无完整真实调用证据；旧版证据只用于追溯。
- **可配置，未完成当前认证**：保留旧版证据，但缺少当前强制检查中的一项或多项，不计入已认证。
- 维护者批准的网络例外不计入认证数量，也不得写入成功台账；版本边界必须在[已知限制](../release/KNOWN-LIMITATIONS.zh-CN.md)中公开。
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
          ? "Configurable, current build unverified (tested artifact evidence retained)"
          : item.certificationGap?.length
            ? `Configurable, incomplete current certification (missing ${item.certificationGap.join(", ")})`
            : "Configurable, unverified";
    return `| \`${item.id}\`${item.aliasOf ? ` (compatibility alias of \`${item.aliasOf}\`)` : ""} | \`${item.defaultModel}\` | ${version ? `\`${version}\`` : "—"} | ${item.modelCount} | ${status} | ${evidence ? `[Evidence](${evidence})` : "—"} |`;
  });
  return `# Provider Support and Certification Matrix

> Models come from the catalog pinned by this source tree. Certification records in the ${data.generatedAt} ledger must match target version \`${data.targetVersion}\` and the SHA-256 of the bundled runtime. This page is generated.

CoreMind has **${data.providers.filter((item) => !item.aliasOf).length}** built-in chat providers and **${data.summary.supported}** configurable entries including compatibility aliases. **${data.summary.certified}** entries have complete real-call evidence for the current build. **${data.summary.unverified}** entries await certification.

## Status definitions

- **Certified**: the same model passed real streaming, tool-call, structured-result, multi-turn, abort, error-mapping, long-context, and parent/child Agent product-chain checks with auditable evidence.
- **Configurable, unverified**: configuration and model catalog resolution work, but the current version lacks complete real-call evidence; older evidence is historical only.
- **Configurable, incomplete current certification**: earlier evidence is retained but does not cover every current required check.
- A maintainer-approved network exception is not counted as certification and cannot enter the success ledger; disclose its version boundary in [Known limitations](../release/KNOWN-LIMITATIONS.en.md).
- Custom OpenAI-compatible endpoints are deployment-specific and must be accepted by each project.

## Current matrix

| Provider ID | Default model | Certified version | Models | Status | Evidence |
|---|---|---|---:|---|---|
${rows.join("\n")}

## Adding a certification

Follow the [Provider certification SOP](CERTIFICATION.en.md). Add records only to \`certifications.json\`, then run \`npm run providers:matrix\`. Never mark a provider as certified without real credentials, run logs, and error-path evidence.
`;
}

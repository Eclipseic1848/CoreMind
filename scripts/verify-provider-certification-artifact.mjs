import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCertificationEvidence } from "./provider-certification.mjs";

export async function verifyProviderCertificationArtifact(directory, expectedCommit) {
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) throw new Error("候选提交必须是完整 SHA");
  const ledgerFiles = await findNamedFiles(path.resolve(directory), "certifications.json");
  for (const ledgerFile of ledgerFiles) {
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    const evidenceFiles = await findJsonFiles(path.join(path.dirname(ledgerFile), "evidence"));
    for (const evidenceFile of evidenceFiles) {
      const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
      if (evidence.commit !== expectedCommit) continue;
      const validated = createCertificationEvidence(evidence);
      if (
        evidence.schemaVersion !== 2 ||
        evidence.dataPolicy !== "synthetic-only" ||
        evidence.secretsRecorded !== false
      ) {
        throw new Error("Provider 认证证据的数据边界无效");
      }
      const record = ledger.certifications?.find(
        (item) => item.id === evidence.provider && item.version === evidence.version,
      );
      if (
        !record ||
        record.model !== evidence.model ||
        record.commit !== evidence.commit ||
        record.runtimeArtifactSha256 !== evidence.runtimeArtifactSha256
      ) {
        throw new Error("认证台账与证据不一致");
      }
      return {
        provider: validated.provider,
        model: validated.model,
        version: validated.version,
        commit: validated.commit,
        runtimeArtifactSha256: validated.runtimeArtifactSha256,
      };
    }
  }
  throw new Error(`Provider 认证 Artifact 没有绑定候选提交：${expectedCommit}`);
}

async function findNamedFiles(directory, name) {
  const files = [];
  for (const entry of await safeReadDirectory(directory)) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findNamedFiles(fullPath, name)));
    else if (entry.name === name) files.push(fullPath);
  }
  return files;
}

async function findJsonFiles(directory) {
  return (await safeReadDirectory(directory))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name));
}

async function safeReadDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  const commitIndex = process.argv.indexOf("--commit");
  const expectedCommit = commitIndex >= 0 ? process.argv[commitIndex + 1] : undefined;
  if (!directory || !expectedCommit) {
    throw new Error(
      "用法：node scripts/verify-provider-certification-artifact.mjs <目录> --commit <SHA>",
    );
  }
  const result = await verifyProviderCertificationArtifact(directory, expectedCommit);
  console.log(`Provider 认证 Artifact 通过：${result.provider}/${result.model} · ${result.commit}`);
}

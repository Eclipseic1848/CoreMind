import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(
  await readFile(path.join(root, ".github", "security-audit-policy.json"), "utf8"),
);
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

if (Date.parse(`${policy.expiresAt}T23:59:59Z`) < Date.now()) {
  fail(`开发依赖风险处置已过期：${policy.expiresAt}`);
}

for (const forbiddenScript of ["docs:dev", "docs:preview"]) {
  if (packageJson.scripts?.[forbiddenScript]) {
    fail(`风险处置要求不得提供 ${forbiddenScript} 开发服务器命令`);
  }
}

const production = runAudit(["audit", "--omit=dev", "--json"]);
const productionNames = Object.keys(production.vulnerabilities ?? {});
if (productionNames.length > 0) {
  fail(`生产依赖存在漏洞：${productionNames.join("、")}`);
}

const complete = runAudit(["audit", "--json"], true);
const findings = complete.vulnerabilities ?? {};
const allowed = policy.allowedDevelopmentOnlyPackages ?? {};
const findingNames = Object.keys(findings).sort();
const allowedNames = Object.keys(allowed).sort();
if (JSON.stringify(findingNames) !== JSON.stringify(allowedNames)) {
  fail(`开发依赖发现与已审查清单不一致：发现 ${findingNames.join("、") || "无"}`);
}

const severityOrder = ["info", "low", "moderate", "high", "critical"];
for (const [name, finding] of Object.entries(findings)) {
  const maximum = allowed[name].maximumSeverity;
  if (severityOrder.indexOf(finding.severity) > severityOrder.indexOf(maximum)) {
    fail(`${name} 风险等级 ${finding.severity} 超出已审查上限 ${maximum}`);
  }
}

console.log(
  `安全审计通过：生产依赖 0 个漏洞；${findingNames.length} 个仅开发依赖风险已隔离并登记至 ${policy.expiresAt}。`,
);

function runAudit(arguments_, allowFailure = false) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : "npm";
  const commandArguments = npmCli ? [npmCli, ...arguments_] : arguments_;
  const result = spawnSync(command, commandArguments, { cwd: root, encoding: "utf8" });
  if (result.error) fail(`无法执行 npm audit：${result.error.message}`);
  if (!allowFailure && result.status !== 0)
    fail(result.stdout || result.stderr || "npm audit 失败");
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`npm audit 未返回合法 JSON：${result.stderr}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

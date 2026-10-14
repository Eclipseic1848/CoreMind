import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(
  await readFile(path.join(root, ".github", "security-audit-policy.json"), "utf8"),
);
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const expiry = Date.parse(`${policy.expiresAt}T23:59:59Z`);
if (
  typeof policy.expiresAt !== "string" ||
  !/^\d{4}-\d{2}-\d{2}$/.test(policy.expiresAt) ||
  !Number.isFinite(expiry) ||
  new Date(expiry).toISOString().slice(0, 10) !== policy.expiresAt
) {
  fail("开发依赖风险处置缺少有效的到期日");
}
if (expiry < Date.now()) {
  fail(`开发依赖风险处置已过期：${policy.expiresAt}`);
}

for (const forbiddenScript of ["docs:dev", "docs:preview"]) {
  if (packageJson.scripts?.[forbiddenScript]) {
    fail(`风险处置要求不得提供 ${forbiddenScript} 开发服务器命令`);
  }
}

const severityOrder = ["info", "low", "moderate", "high", "critical"];
const production = runAudit(["audit", "--omit=dev", "--json"], true);
const productionNames = Object.keys(production.vulnerabilities);
if (productionNames.length > 0) {
  fail(`生产依赖存在漏洞：${productionNames.join("、")}`);
}

const complete = runAudit(["audit", "--json"], true);
const findings = complete.vulnerabilities;
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const allowed = policy.allowedDevelopmentOnlyPackages ?? {};
const findingNames = Object.keys(findings).sort();
const unreviewedNames = findingNames.filter((name) => !Object.hasOwn(allowed, name));
if (unreviewedNames.length > 0) {
  fail(`开发依赖存在未审查风险：${unreviewedNames.join("、")}`);
}

for (const [name, finding] of Object.entries(findings)) {
  const disposition = allowed[name];
  const maximum = disposition.maximumSeverity;
  if (!severityOrder.includes(maximum)) fail(`${name} 缺少有效的审查风险上限`);
  if (severityOrder.indexOf(finding.severity) > severityOrder.indexOf(maximum)) {
    fail(`${name} 风险等级 ${finding.severity} 超出已审查上限 ${maximum}`);
  }
  if (
    !Array.isArray(disposition.versions) ||
    !Array.isArray(finding.nodes) ||
    finding.nodes.length === 0 ||
    finding.nodes.some((node) => !disposition.versions.includes(lock.packages?.[node]?.version))
  ) {
    fail(`${name} 安装版本不在已审查范围`);
  }
  const advisories = collectAdvisories(name);
  if (
    !Array.isArray(disposition.advisories) ||
    advisories.size === 0 ||
    [...advisories].some((url) => !disposition.advisories.includes(url))
  ) {
    fail(`${name} 存在未审查的安全公告`);
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
  if (result.status !== 0 && !(allowFailure && result.status === 1))
    fail(result.stdout || result.stderr || "npm audit 失败");
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    fail(`npm audit 未返回合法 JSON：${result.stderr}`);
  }
  if (
    report?.auditReportVersion !== 2 ||
    Object.hasOwn(report, "error") ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== "object" ||
    Array.isArray(report.vulnerabilities)
  ) {
    fail(`npm audit 未返回完整审计报告：${result.stdout || result.stderr}`);
  }
  const findings = Object.values(report.vulnerabilities);
  if (
    report.metadata?.vulnerabilities?.total !== findings.length ||
    (result.status !== 0 && findings.length === 0) ||
    findings.some((finding) => !severityOrder.includes(finding?.severity))
  ) {
    fail(`npm audit 报告与退出状态不一致或风险等级无效：${result.stdout}`);
  }
  return report;
}

/** 传递风险按真实公告追溯，包名相同不能放行后来新增的公告。 */
function collectAdvisories(name, visited = new Set()) {
  if (visited.has(name)) return new Set();
  visited.add(name);
  const via = findings[name]?.via;
  if (!Array.isArray(via) || via.length === 0) fail(`${name} 缺少可审查的安全公告来源`);
  const urls = new Set();
  for (const item of via) {
    if (typeof item === "string") {
      for (const url of collectAdvisories(item, visited)) urls.add(url);
    } else if (
      typeof item?.url === "string" &&
      item.url.startsWith("https://github.com/advisories/GHSA-")
    ) {
      urls.add(item.url);
    } else {
      fail(`${name} 包含无法识别的安全公告来源`);
    }
  }
  return urls;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

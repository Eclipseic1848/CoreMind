import { access, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CoreMindConfig, QualityConfig } from "coremind-config";
import { CoreMindError } from "./errors.js";
import { inspectExecutionSecurity } from "./execution-security.js";

export type CheckSeverity = "error" | "warning" | "info";

export interface CheckFinding {
  code: string;
  severity: CheckSeverity;
  message: string;
  path?: string;
  overridable: boolean;
  overridden?: boolean;
}

export interface ProjectCheckReport {
  profile: "development" | "standard" | "strict";
  passed: boolean;
  findings: CheckFinding[];
  overrideRecord?: {
    reason: string;
    recordedAt: string;
    codes: string[];
    auditFile: string;
  };
}

export interface ProjectCheckOptions {
  config: CoreMindConfig;
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  profile?: QualityConfig["profile"];
  overrideReason?: string;
}

const REQUIRED_PROJECT_FILES = [
  "tests/README.md",
  "evals/scenarios.yaml",
  "docs/requirements.zh-CN.md",
  "docs/requirements.en.md",
  "docs/architecture.zh-CN.md",
  "docs/architecture.en.md",
  "docs/development-sop.zh-CN.md",
  "docs/development-sop.en.md",
  "docs/testing-guide.zh-CN.md",
  "docs/testing-guide.en.md",
  "docs/acceptance-checklist.zh-CN.md",
  "docs/acceptance-checklist.en.md",
  "skills/project-agent/SKILL.md",
  ".coremind/decisions.md",
] as const;

/** development/standard/strict 三档静态质量门禁。 */
export async function checkProject(options: ProjectCheckOptions): Promise<ProjectCheckReport> {
  const profile = options.profile ?? options.config.quality?.profile ?? "standard";
  const findings: CheckFinding[] = [];
  const env = options.env ?? process.env;

  for (const finding of inspectExecutionSecurity(
    options.config,
    (name) => typeof env[name] === "string" && env[name]!.length > 0,
  )) {
    findings.push({
      code: finding.code,
      severity: "error",
      message: finding.message,
      path: finding.path,
      overridable: false,
    });
  }
  if (!options.config.permissions) {
    findings.push({
      code: "PERMISSIONS_IMPLICIT",
      severity: profile === "development" ? "warning" : "error",
      message: "未显式声明 permissions；虽然 Runtime 使用安全默认值，但发布前必须确认",
      path: "coremind.yaml",
      overridable: true,
    });
  }
  if (!options.config.runtime) {
    findings.push({
      code: "BUDGETS_IMPLICIT",
      severity: profile === "strict" ? "error" : "warning",
      message: "未显式声明 runtime 多维预算",
      path: "coremind.yaml",
      overridable: true,
    });
  }
  if (options.config.permissions?.workspaceOnly === false) {
    findings.push({
      code: "SECURITY_WORKSPACE_UNBOUNDED",
      severity: "error",
      message: "workspaceOnly=false 会允许文件工具访问工作区外路径",
      path: "coremind.yaml",
      overridable: false,
    });
  }

  for (const relative of REQUIRED_PROJECT_FILES) {
    if (await exists(path.join(options.projectDir, relative))) continue;
    findings.push({
      code: "PROJECT_MATERIAL_MISSING",
      severity: profile === "development" ? "warning" : "error",
      message: `缺少项目开发材料：${relative}`,
      path: relative,
      overridable: true,
    });
  }

  const overrideCodes: string[] = [];
  const allowOverride = options.config.quality?.allowOverride ?? true;
  if (allowOverride && options.overrideReason?.trim()) {
    for (const finding of findings) {
      if (finding.severity === "error" && finding.overridable) {
        finding.overridden = true;
        overrideCodes.push(finding.code);
      }
    }
  }
  const passed = !findings.some(
    (finding) => finding.severity === "error" && finding.overridden !== true,
  );
  const overrideRecord =
    overrideCodes.length > 0
      ? await recordQualityOverride({
          projectDir: options.projectDir,
          profile,
          reason: options.overrideReason!.trim(),
          codes: [...new Set(overrideCodes)],
        })
      : undefined;
  return {
    profile,
    passed,
    findings,
    ...(overrideRecord ? { overrideRecord } : {}),
  };
}

async function recordQualityOverride(options: {
  projectDir: string;
  profile: ProjectCheckReport["profile"];
  reason: string;
  codes: string[];
}): Promise<NonNullable<ProjectCheckReport["overrideRecord"]>> {
  const auditDirectory = path.join(options.projectDir, ".coremind");
  const auditFile = path.join(auditDirectory, "quality-overrides.jsonl");
  const record = {
    reason: options.reason,
    recordedAt: new Date().toISOString(),
    codes: options.codes,
    profile: options.profile,
  };

  try {
    await mkdir(auditDirectory, { recursive: true });
    await appendFile(auditFile, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    throw new CoreMindError(
      "quality_override_audit_failed",
      `无法记录质量门禁覆盖：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ...record, auditFile };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

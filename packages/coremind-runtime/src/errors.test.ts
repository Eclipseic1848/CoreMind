import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CoreMindError,
  cancelSignalForCode,
  ERROR_CODES,
  retryClassForCode,
  terminalStatusForCode,
} from "./errors.js";

// 规格 03（docs/spec/0.3.x-a/03-cancellation-and-quiescence.md §2）列出的码表契约。
const SPEC_CODES = {
  取消类: ["aborted", "run_timeout", "step_timeout", "budget_exceeded"],
  暂停类: ["loop_paused", "tool_approval_denied"],
  恢复类: [
    "resume_input_mismatch",
    "run_already_finished",
    "operation_not_resumable",
    "committed_effect_pending",
    "unknown_effect",
  ],
  损坏类: [
    "run_state_corrupt",
    "run_state_conflict",
    "run_state_locked",
    "checkpoint_corrupt",
    "checkpoint_conflict",
    "loop_snapshot_invalid",
    "loop_snapshot_mismatch",
    "session_layout_conflict",
  ],
} as const;

function collectCoreMindErrorLiterals(directory: string): string[] {
  const codes: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "node_modules") {
        codes.push(...collectCoreMindErrorLiterals(path));
      }
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/new\s+CoreMindError\s*\(\s*["']([^"']+)["']/g)) {
      codes.push(match[1]);
    }
  }
  return codes;
}

function collectPythonProtocolErrorLiterals(directory: string): string[] {
  const codes: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      codes.push(...collectPythonProtocolErrorLiterals(path));
      continue;
    }
    if (!entry.name.endsWith(".py")) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/coremind_code\s*=\s*["']([^"']+)["']/g)) {
      codes.push(match[1]);
    }
  }
  return codes;
}

describe("错误码码表（单一事实源）", () => {
  it("包含规格 03 列出的全部码", () => {
    for (const group of Object.values(SPEC_CODES)) {
      for (const code of group) {
        expect(ERROR_CODES[code], `缺少规格码：${code}`).toBeDefined();
      }
    }
  });

  it("仓库内 CoreMindError 字面量构造点全部使用已登记码", () => {
    const packagesDirectory = resolve(import.meta.dirname, "../..");
    const unregistered = [...new Set(collectCoreMindErrorLiterals(packagesDirectory))]
      .filter((code) => !(code in ERROR_CODES))
      .sort();
    expect(unregistered).toEqual([]);
  });

  it("Python SDK 自有错误字面量全部使用已登记码", () => {
    const pythonSourceDirectory = resolve(import.meta.dirname, "../../../python/src/coremind");
    const unregistered = [...new Set(collectPythonProtocolErrorLiterals(pythonSourceDirectory))]
      .filter((code) => !(code in ERROR_CODES))
      .sort();
    expect(unregistered).toEqual([]);
  });

  it("Python SDK 发布的错误分类由唯一注册表完整派生", () => {
    const contractPath = resolve(
      import.meta.dirname,
      "../../../python/src/coremind/_error_contract.json",
    );
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
      schemaVersion: number;
      codes: unknown;
    };
    expect(contract.schemaVersion).toBe(1);
    expect(contract.codes).toEqual(ERROR_CODES);
  });

  it("每个码都有三个分类属性", () => {
    for (const [code, info] of Object.entries(ERROR_CODES)) {
      expect(info.terminality, `${code}.terminality`).toMatch(/^(terminal|pausable|transient)$/);
      expect(info.cancelClass, `${code}.cancelClass`).toMatch(
        /^(cancel|timeout|budget|human|corruption|other)$/,
      );
      expect(info.retryClass, `${code}.retryClass`).toMatch(/^(human|transient|fatal)$/);
    }
  });

  it("规格码的取消分类与规格 03 一致", () => {
    expect(ERROR_CODES.aborted.cancelClass).toBe("cancel");
    expect(ERROR_CODES.run_timeout.cancelClass).toBe("timeout");
    expect(ERROR_CODES.step_timeout.cancelClass).toBe("timeout");
    expect(ERROR_CODES.budget_exceeded.cancelClass).toBe("budget");
    expect(ERROR_CODES.loop_paused.cancelClass).toBe("human");
    expect(ERROR_CODES.tool_approval_denied.cancelClass).toBe("human");
    const corruptionCodes = SPEC_CODES.损坏类 as readonly string[];
    for (const code of [...SPEC_CODES.恢复类, ...SPEC_CODES.损坏类]) {
      expect(ERROR_CODES[code].cancelClass, code).toBe(
        corruptionCodes.includes(code) ? "corruption" : "human",
      );
    }
  });

  it("terminalStatusForCode 从码表派生，未知码失败关闭", () => {
    expect(terminalStatusForCode("unclassified_error")).toBe("paused");
    expect(terminalStatusForCode("loop_paused")).toBe("paused");
    expect(terminalStatusForCode("aborted")).toBe("aborted");
    expect(terminalStatusForCode("run_timeout")).toBe("timeout");
    expect(terminalStatusForCode("step_timeout")).toBe("timeout");
    expect(terminalStatusForCode("budget_exceeded")).toBe("budget_exceeded");
    expect(terminalStatusForCode("retry_limit")).toBe("budget_exceeded");
    expect(terminalStatusForCode("approval_denied")).toBe("failed");
    expect(terminalStatusForCode("workspace_lease_recovery_required")).toBe("paused");
    expect(terminalStatusForCode("context_budget_exhausted")).toBe("paused");
    expect(terminalStatusForCode("context_lineage_corrupt")).toBe("failed");
    expect(terminalStatusForCode("run_state_corrupt")).toBe("failed");
    expect(terminalStatusForCode("unknown_agent")).toBe("failed");
    expect(terminalStatusForCode("not_a_real_code")).toBe("failed");
  });

  it("cancelSignalForCode 从码表派生，未知码失败关闭", () => {
    expect(cancelSignalForCode("aborted")).toBe("abort");
    expect(cancelSignalForCode("run_timeout")).toBe("timeout");
    expect(cancelSignalForCode("budget_exceeded")).toBe("budget_exceeded");
    expect(cancelSignalForCode("approval_denied")).toBe("pause");
    expect(cancelSignalForCode("loop_paused")).toBe("pause");
    expect(cancelSignalForCode("context_budget_exhausted")).toBe("pause");
    // 恢复类码是 cancelClass=human 但 retryClass=fatal：现状语义为 FAIL 而非 PAUSE
    expect(cancelSignalForCode("resume_input_mismatch")).toBe("fail");
    expect(cancelSignalForCode("run_state_corrupt")).toBe("fail");
    expect(cancelSignalForCode("unknown_agent")).toBe("fail");
    expect(cancelSignalForCode("not_a_real_code")).toBe("fail");
  });

  it("retryClassForCode 查询码表，未知码返回 undefined", () => {
    expect(retryClassForCode("approval_denied")).toBe("human");
    expect(retryClassForCode("network_error")).toBe("transient");
    expect(retryClassForCode("aborted")).toBe("fatal");
    expect(retryClassForCode("not_a_real_code")).toBeUndefined();
  });

  it("CoreMindError 保留错误码、名称与消息", () => {
    const error = new CoreMindError("aborted", "执行已中止");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CoreMindError");
    expect(error.code).toBe("aborted");
    expect(error.message).toBe("执行已中止");
  });
});

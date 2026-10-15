import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CoreMindError } from "../../coremind-runtime/src/errors.js";
import { renderChatEvent } from "./commands/chat.js";
import {
  errorLine,
  formatArtifactReference,
  formatControlReceipt,
  formatInputReceipt,
  loopStateLine,
  summarizeTerminalArguments,
  terminalText,
  toolLine,
} from "./render.js";

describe("Loop 终端渲染", () => {
  it("把内部状态转换为新手可读的进度", () => {
    expect(loopStateLine("repairing", 2, 1)).toContain("修复中 · 第 2 轮 · 已修复 1 次");
    expect(loopStateLine("paused", 2, 1)).toContain("已暂停");
  });
});

describe("终端安全格式器", () => {
  it("已注册的彩色凭据异常经过共享脱敏后，终端再次展示仍无秘密", () => {
    const error = new CoreMindError(
      "agent_failed",
      "password=\x1b[31mterminal-typed-color-canary\x1b[0m",
    );
    expect(error.code).toBe("agent_failed");
    expect(error.message).toBe("password=hidden");
    expect(terminalText(error.message)).toBe("password=hidden");
    expect(errorLine(error.message)).not.toContain("terminal-typed-color-canary");
  });
  it.each(["api_\x1b[31mkey", "pass\x1b[0mword", "to\x01ken"])(
    "移除控制码后形成的凭据标签仍完整脱敏：%j",
    (label) => {
      const value = `${label}=terminal-control-secret-canary`;
      expect(terminalText(value)).not.toContain("terminal-control-secret-canary");
      expect(errorLine(value)).not.toContain("terminal-control-secret-canary");
    },
  );
  it("参数和错误在截断前净化凭据及终端控制序列，保留false/0/null", () => {
    const args = {
      enabled: false,
      count: 0,
      value: null,
      token: "markerSECRET",
      headers: { Cookie: "session=markerCOOKIE" },
      endpoint: "https://user:markerPASSWORD@example.invalid/?access_token=markerQUERY&mode=safe",
      content: "不应复制的正文",
    };
    const original = structuredClone(args);
    const display = summarizeTerminalArguments(args);
    expect(display).toContain("false");
    expect(display).toContain("0");
    expect(display).toContain("null");
    expect(display).not.toContain("marker");
    expect(display).not.toContain("不应复制的正文");
    expect(toolLine("read", args)).not.toContain("marker");
    expect(errorLine("Bearer markerSECRET\x1b[2J\r覆写\x07")).not.toContain("markerSECRET");
    expect(args).toEqual(original);
  });

  it("外来ANSI/OSC/回擦控制不可执行，普通中文保留", () => {
    const text = terminalText(
      "中文\x1b[31m红字\x1b[0m\x1b]8;;https://evil.invalid\x07链接\x1b]8;;\x07\r\b\x07末尾",
    );
    expect(text).toContain("中文");
    expect(text).toContain("末尾");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 验证外来控制字符确实被移除。
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u);
    expect(text).not.toContain("evil.invalid");
  });

  it("多字节文本的省略标记计入字符簇与UTF8字节上限，不切坏emoji", () => {
    const output = terminalText("中文👩‍👩‍👧‍👦".repeat(20_000));
    expect(output).toContain("…");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(65_536);
    expect(
      Array.from(new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(output)).length,
    ).toBeLessThanOrEqual(16_384);
    expect(output).not.toContain("�");
    expect(output).not.toMatch(/[\uD800-\uDBFF]$/u);
    const summary = summarizeTerminalArguments({ data: "中👩‍👩‍👧‍👦".repeat(2000) });
    expect(summary).toContain("…");
    expect(
      Array.from(new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(summary)).length,
    ).toBeLessThanOrEqual(512);
  });

  it("循环和超深参数仅保留固定摘要", () => {
    const args: Record<string, unknown> = { value: 0 };
    args.self = args;
    expect(() => summarizeTerminalArguments(args)).not.toThrow();
    expect(summarizeTerminalArguments(args)).toContain("省略");
  });

  it("blocked产物保留真实ID，不把路径显示成可打开引用", () => {
    const display = formatArtifactReference({
      artifactId: "blocked-artifact",
      status: "blocked",
      sizeBytes: 0,
      mediaType: "text/plain",
      relativePath: ".coremind/artifacts/should-not-open.txt",
    });
    expect(display).toContain("blocked-artifact");
    expect(display).toContain("不能打开");
    expect(display).not.toContain("should-not-open");
  });

  it.each([
    "C:\\private\\file.txt",
    "/etc/passwd",
    "\\\\server\\share\\file",
    "../private.txt",
    "safe/../../private.txt",
    "file:///C:/private.txt",
    "https://example.invalid/output",
    "safe\nforged.txt",
    "safe\tforged.txt",
  ])("stored事件的不安全引用不变成可打开路径：%s", (relativePath) => {
    const display = formatArtifactReference({
      artifactId: "artifact-safe",
      status: "stored",
      sizeBytes: 4,
      mediaType: "text/plain",
      relativePath,
    });
    expect(display).toContain("artifact-safe");
    expect(display).not.toContain(relativePath);
  });

  it("stored框架相对引用完整显示且没有打开动作", () => {
    const display = formatArtifactReference({
      artifactId: "artifact-real",
      status: "stored",
      sizeBytes: 4,
      mediaType: "text/plain",
      relativePath: ".coremind/artifacts/artifact-real.txt",
    });
    expect(display).toContain("artifact-real");
    expect(display).toContain(".coremind/artifacts/artifact-real.txt");
  });

  it("控制applied与输入claimed/completed/discarded不混同", () => {
    const receipt = formatControlReceipt({
      schemaVersion: 1,
      controlId: "control-real",
      runId: "run-real",
      status: "applied",
    });
    expect(receipt).toContain("applied");
    expect(receipt).not.toContain("已消费");
    expect(
      formatInputReceipt({ inputId: "input-real", status: "claimed", turnId: "turn-real" }),
    ).toContain("turn-real");
    expect(formatInputReceipt({ inputId: "input-real", status: "discarded" })).toContain(
      "discarded",
    );
  });

  it("readline每条工具证据带它实际携带的身份，缺id明确未绑定", () => {
    let text = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    });
    renderChatEvent(
      {
        type: "tool_execution_evidence",
        agent: "worker",
        stepId: "step-real",
        callId: "call-real",
        tool: "read",
        execution: { durationMs: 17, exitCode: null },
      },
      output,
    );
    expect(text).toContain("worker");
    expect(text).toContain("step-real");
    expect(text).toContain("call-real");
    expect(text).toContain("17");
    renderChatEvent({ type: "tool_result", agent: "main", tool: "read", isError: false }, output);
    expect(text).toContain("未绑定");
  });
});

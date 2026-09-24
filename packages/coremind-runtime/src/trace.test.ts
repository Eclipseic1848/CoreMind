import { describe, expect, it, vi } from "vitest";
import { redactSensitiveText, TraceRecorder } from "./trace.js";

describe("Trace 敏感信息保护", () => {
  it.each([
    "正文 sk-testcredential123456 尾部 普通 内容",
    "正文 Bearer testcredential123456 尾部 普通 内容",
    "正文 token = testcredential123456 尾部 普通 内容",
    '正文 {"password":"testcredential123456"} 尾部 普通 内容',
    '正文 password="testcredential123456" 尾部 普通 内容',
    "Cookie: session=testcredential123456; other=value\n正文",
    "正文 https://user:password@example.invalid/?token=testcredential123456 尾部 普通 内容",
    "正文 -----BEGIN PRIVATE KEY-----\ntestcredential123456\n-----END PRIVATE KEY----- 尾部",
  ])("逐字符流式凭据不会进入 Trace：%s", (text) => {
    const recorder = new TraceRecorder("stream");
    for (const delta of text) recorder.record({ type: "text_delta", agent: "main", delta });
    const end = recorder.record({
      type: "turn_end",
      agent: "main",
      tokens: 12,
      inputTokens: 7,
      outputTokens: 5,
    });
    const joined = recorder.entries
      .flatMap(({ event }) => (event.type === "text_delta" ? [event.delta] : []))
      .join("");
    expect(joined).toBe(redactSensitiveText(text));
    expect(JSON.stringify(recorder.entries)).not.toContain("testcredential123456");
    expect(end.event).toMatchObject({ tokens: 12, inputTokens: 7, outputTokens: 5 });
  });

  it("保留普通正文与 URL，文本错误及步骤正文清除凭据", () => {
    const recorder = new TraceRecorder("text");
    const text = "普通正文 https://example.invalid 保持不变";
    expect(redactSensitiveText(text)).toBe(text);
    expect(redactSensitiveText("Please change your password before continuing.")).toBe(
      "Please change your password before continuing.",
    );
    expect(
      recorder.record({ type: "step_output", agent: "main", stepId: "step", text }).event,
    ).toMatchObject({ text });
    expect(
      JSON.stringify(
        recorder.record({ type: "error", fatal: true, message: "Bearer private-value" }),
      ),
    ).not.toContain("private-value");
  });
  it.each([
    "https://example.invalid/sk-markerSECRET0123456789",
    "https://example.invalid/#password=markerSECRET",
  ])("纯 URL 错误文本不会绕过脱敏：%s", (message) => {
    expect(
      JSON.stringify(new TraceRecorder("url").record({ type: "error", fatal: true, message })),
    ).not.toContain("markerSECRET");
  });

  it("循环参数可安全脱敏并生成稳定指纹", () => {
    const firstArgs: Record<string, unknown> = { path: "result.md" };
    firstArgs.self = firstArgs;
    const secondArgs: Record<string, unknown> = { path: "result.md" };
    secondArgs.self = secondArgs;
    const recorder = new TraceRecorder("run-circular-tool-call");

    const first = recorder.record({
      type: "tool_call",
      agent: "main",
      tool: "write",
      callId: "call-circular-1",
      args: firstArgs,
    });
    const second = recorder.record({
      type: "tool_call",
      agent: "main",
      tool: "write",
      callId: "call-circular-2",
      args: secondArgs,
    });

    expect(first.event).toMatchObject({
      type: "tool_call",
      args: { path: "result.md", self: "<循环引用已省略>" },
      argumentsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect((first.event as { argumentsFingerprint?: string }).argumentsFingerprint).toBe(
      (second.event as { argumentsFingerprint?: string }).argumentsFingerprint,
    );
  });

  it("Tool Call 脱敏前冻结参数指纹，且同长度正文不会碰撞", () => {
    const recorder = new TraceRecorder("run-tool-call");
    const first = recorder.record({
      type: "tool_call",
      agent: "main",
      tool: "write",
      callId: "call-1",
      args: { path: "result.md", content: "秘密甲" },
    });
    const second = recorder.record({
      type: "tool_call",
      agent: "main",
      tool: "write",
      callId: "call-2",
      args: { path: "result.md", content: "秘密乙" },
    });

    expect(first.event).toMatchObject({
      type: "tool_call",
      args: { path: "result.md", content: "<content 已隐藏：3 字符>" },
      argumentsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(second.event).toMatchObject({
      type: "tool_call",
      args: { path: "result.md", content: "<content 已隐藏：3 字符>" },
      argumentsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const firstFingerprint = (first.event as { argumentsFingerprint?: string })
      .argumentsFingerprint;
    const secondFingerprint = (second.event as { argumentsFingerprint?: string })
      .argumentsFingerprint;
    expect(firstFingerprint).not.toBe(secondFingerprint);
  });

  it("持久化和转发前隐藏凭据、正文与命令，同时保留可审计目标", () => {
    const forward = vi.fn();
    const recorder = new TraceRecorder("run-1", forward);
    const event = {
      type: "approval_required" as const,
      approvalId: "approval-1",
      runId: "run-1",
      agent: "main",
      tool: "write",
      args: {
        path: "reports/result.md",
        content: "正文中的私密内容",
        apiKey: "api-secret-value",
        headers: { Authorization: "Bearer private-token" },
        command: "curl https://example.com?token=command-secret",
      },
      risk: "low" as const,
      effect: {
        operations: ["write" as const],
        paths: ["reports/result.md"],
        urls: ["https://example.com/run?token=url-secret&mode=safe"],
        reversible: true,
      },
    };

    const entry = recorder.record(event);
    const secondEntry = recorder.record({
      ...event,
      approvalId: "approval-2",
      args: { ...event.args, content: "长度相同但内容不同" },
    });
    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain("私密内容");
    expect(serialized).not.toContain("api-secret-value");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("command-secret");
    expect(serialized).not.toContain("url-secret");
    expect(serialized).toContain("reports/result.md");
    expect(serialized).toContain("mode=safe");
    expect(entry.event).toMatchObject({
      type: "approval_required",
      argumentsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect((entry.event as { argumentsFingerprint?: string }).argumentsFingerprint).not.toBe(
      (secondEntry.event as { argumentsFingerprint?: string }).argumentsFingerprint,
    );
    expect(forward).toHaveBeenCalledWith(entry);
    expect(JSON.stringify(event)).toContain("api-secret-value");
  });
});

import { describe, expect, it, vi } from "vitest";
import { TraceRecorder } from "./trace.js";

describe("Trace 敏感信息保护", () => {
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
    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain("私密内容");
    expect(serialized).not.toContain("api-secret-value");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("command-secret");
    expect(serialized).not.toContain("url-secret");
    expect(serialized).toContain("reports/result.md");
    expect(serialized).toContain("mode=safe");
    expect(forward).toHaveBeenCalledWith(entry);
    expect(JSON.stringify(event)).toContain("api-secret-value");
  });
});

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoreMindRuntime } from "coremind-ai";
import { describe, expect, it, vi } from "vitest";
import { formatObservabilityStatus } from "../observability-format.js";
import { cmdRun, exitCodeForRunStatus } from "./run.js";

describe("run 终态退出码", () => {
  it.each([
    ["succeeded", 0],
    ["failed", 1],
    ["paused", 2],
    ["budget_exceeded", 3],
    ["timeout", 124],
    ["aborted", 130],
  ] as const)("%s 返回 %i", (status, expected) => {
    expect(exitCodeForRunStatus(status)).toBe(expected);
  });
});

describe("本地观测状态", () => {
  it("显式显示本地开启、Telemetry 模式与交付队列", () => {
    const status = formatObservabilityStatus({
      schemaVersion: 1,
      localEnabled: true,
      derivedFromSequence: 3,
      run: { status: "finished", resumable: false },
      turns: { started: 1, completed: 1, active: 0 },
      calls: { started: 1, completed: 1, failed: 0, active: 0, durationMs: 4 },
      tools: [
        {
          version: 1,
          agent: "main",
          callId: "call-1",
          tool: "read",
          currentPhase: "capability_resolved",
          terminal: false,
          phases: [
            { phase: "call_recorded", status: "completed" },
            { phase: "capability_resolved", status: "completed" },
          ],
          result: {
            executionOutcome: "not_invoked",
            effectState: "not_started",
            persistenceState: "pending",
            recoveryDisposition: "replay_safe",
            cleanupState: "not_needed",
            authorizationState: "pending",
            environmentState: "available",
          },
        },
      ],
      errors: [{ sequence: 3, message: "已脱敏错误", fatal: false }],
      context: { budgets: 1, compactions: 0, failures: 0 },
      artifacts: { stored: 0, blocked: 0 },
      sharedState: { pendingControls: 0 },
      recovery: { resumable: false },
      telemetry: {
        mode: "DISABLED",
        source: "default",
        exporterLoaded: false,
        contentLevel: "metrics_only",
        allowedFields: [],
        queued: 0,
        handedOff: 0,
        failed: 0,
        dropped: 0,
        duplicates: 0,
        shutdownTimedOut: false,
        deliverySemantics: "best_effort_handoff_not_delivery",
        authorizedScopes: [
          {
            runId: "run-1",
            consentId: "feedback-1",
            scopeFingerprint: "a".repeat(64),
            kind: "feedback",
            targetOrigin: "https://telemetry.example",
            contentLevel: "metrics_only",
            allowedFields: [],
            throughSequence: 2,
            factPrefixFingerprint: "b".repeat(64),
            grantedAt: "2026-08-24T00:00:00.000Z",
          },
        ],
      },
    });

    expect(status).toContain("Run status=finished resumable=false duration=unknown");
    expect(status).toContain("Turn started=1 completed=1 active=0");
    expect(status).toContain("Call started=1 completed=1 failed=0 active=0 duration=4ms");
    expect(status).toContain(
      "read#call-1@main current=capability_resolved terminal=false phases=[call_recorded:completed>capability_resolved:completed]",
    );
    expect(status).toContain("recoveryDisposition=replay_safe");
    expect(status).toContain("Error #3:recoverable:已脱敏错误");
    expect(status).toContain(
      "consent feedback-1@run-1:feedback:https://telemetry.example:metrics_only:fields=无:through=2",
    );
    expect(status).toContain(
      "queue 0 / handed-off 0 / failed 0 / dropped 0 / duplicates 0 / shutdown-timeout false",
    );
  });
});

it("--print 在工具事件和恢复会话时仅输出最终正文", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coremind-print-"));
  const file = path.join(dir, "config.json");
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 2,
      name: "print-test",
      agents: { main: { model: "openai/gpt-4o-mini" } },
    }),
    "utf8",
  );
  const chunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const logs = vi.spyOn(console, "log").mockImplementation((...args) => {
    chunks.push(args.join(" "));
  });
  const create = vi.spyOn(CoreMindRuntime, "create").mockImplementation(async (options) => {
    options.events?.({ type: "agent_start", agent: "main", timestamp: Date.now() } as never);
    options.events?.({
      type: "text_delta",
      agent: "main",
      text: "增量",
      timestamp: Date.now(),
    } as never);
    return {
      resumedContextLength: 2,
      run: async () => ({
        transcript: "最终正文",
        sessionFile: "session.jsonl",
        outcome: { status: "succeeded" },
      }),
    } as unknown as CoreMindRuntime;
  });
  try {
    expect(await cmdRun({ flags: new Map([["print", true]]), positionals: [file] }, [file])).toBe(
      0,
    );
    expect(chunks.join("")).toBe("最终正文\n");
  } finally {
    create.mockRestore();
    stdout.mockRestore();
    logs.mockRestore();
  }
});

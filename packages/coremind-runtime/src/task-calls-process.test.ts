import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-keyed-crash-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});
function child(scenario: string, point: string) {
  return new Promise<{ code: number | string; killed: boolean; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [
          fileURLToPath(new URL("../../../test/fixtures/task-keyed-calls.mjs", import.meta.url)),
          workspace,
          scenario,
          point,
        ],
        { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) =>
          resolve({ code: error?.code ?? 0, killed: error?.killed ?? false, stdout, stderr }),
      );
    },
  );
}
describe("真实进程稳定键中断恢复", () => {
  it.each(["intent", "projection", "result", "run-finished"])(
    "%s 窗口退出后沿用原 Run 与结果",
    async (point) => {
      expect(await child("unknown", point)).toMatchObject({ code: 23, killed: false, stderr: "" });
      const resumed = await child("unknown", "resume");
      expect(resumed, resumed.stderr).toMatchObject({ code: 0, killed: false });
      const value = JSON.parse(resumed.stdout);
      expect(value, JSON.stringify(value.error)).toMatchObject({
        task: { status: "completed" },
        effect: "once",
      });
      expect(value.error).toBeUndefined();
      expect(value.attempts).toHaveLength(1);
      expect(value.calls[0].status).toBe("completed");
      const terminal = JSON.parse((await child("unknown", "resume")).stdout);
      expect(terminal.attempts).toEqual(value.attempts);
      expect(terminal.calls).toEqual(value.calls);
    },
  );
  it("真实效果已发生但未提交结果，未知能力不自动重放", async () => {
    expect(await child("unknown", "effect")).toMatchObject({ code: 23, killed: false });
    const resumed = await child("unknown", "resume");
    expect(resumed, resumed.stderr).toMatchObject({ code: 0, killed: false });
    const value = JSON.parse(resumed.stdout);
    expect(value.task.status).toBe("paused");
    expect(value.error).toBeDefined();
    expect(value.attempts).toHaveLength(1);
    expect(value.effect).toBe("once");
    expect(value.calls[0].status).toBe("pending");
  });
  it("真实中断的已绑定幂等调用使用新 Call 与关联 attempt，逻辑效果仍一次", async () => {
    expect(await child("idempotent", "effect")).toMatchObject({ code: 23, killed: false });
    const resumed = await child("idempotent", "resume");
    expect(resumed, resumed.stderr).toMatchObject({ code: 0, killed: false });
    const value = JSON.parse(resumed.stdout);
    expect(value, JSON.stringify(value.error)).toMatchObject({
      task: { status: "completed" },
      effect: "once",
    });
    expect(value.attempts).toHaveLength(2);
    expect(new Set(value.attempts).size).toBe(2);
    const events = value.facts
      .filter((fact: { kind: string }) => fact.kind === "event")
      .map((fact: { payload: { event: Record<string, unknown> } }) => fact.payload.event);
    expect(
      events.filter((event: Record<string, unknown>) => event.type === "tool_attempt"),
    ).toEqual([
      expect.objectContaining({
        attempt: 2,
        callId: value.attempts[1],
        previousReceiptId: `${value.calls[0].runId}:${value.calls[0].stepId}:${value.attempts[0]}`,
      }),
    ]);
  });
});

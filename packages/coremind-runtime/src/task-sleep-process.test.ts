import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-sleep-process-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});
function child(mode: string, now: number) {
  return new Promise<{ code: number | string; killed: boolean; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [
          fileURLToPath(new URL("../../../test/fixtures/task-sleep.mjs", import.meta.url)),
          workspace,
          mode,
          String(now),
        ],
        {
          timeout: 10_000,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        },
        (error, stdout, stderr) =>
          resolve({ code: error?.code ?? 0, killed: error?.killed ?? false, stdout, stderr }),
      );
    },
  );
}
describe("真实进程的持久等待恢复", () => {
  it("A提交并睡眠后退出，冷进程重新计算剩余时间，到期B只推进一次", async () => {
    expect(await child("sleep-exit", 500)).toMatchObject({ code: 23, killed: false, stderr: "" });
    const early = await child("resume", 900);
    expect(early, early.stderr).toMatchObject({ code: 0, killed: false });
    expect(JSON.parse(early.stdout)).toMatchObject({
      task: { phase: "b", status: "sleeping", checkpoint: 1 },
      next: { wakeAt: 1000, remainingMs: 100 },
      calls: "A\n",
    });
    const due = await child("resume", 1000);
    expect(due, due.stderr).toMatchObject({ code: 0, killed: false });
    expect(JSON.parse(due.stdout)).toMatchObject({
      task: { status: "completed", checkpoint: 2 },
      calls: "A\nB\n",
    });
    const duplicate = await child("resume", 2000);
    expect(duplicate, duplicate.stderr).toMatchObject({ code: 0, killed: false });
    expect(JSON.parse(duplicate.stdout).calls).toBe("A\nB\n");
  });
  it("wake持久确认后、B执行前退出，重启保留ready并继续B", async () => {
    expect(await child("sleep-exit", 500)).toMatchObject({ code: 23, killed: false, stderr: "" });
    expect(await child("wake-exit", 1000)).toMatchObject({ code: 23, killed: false, stderr: "" });
    const recovered = await child("inspect", 1000);
    expect(recovered, recovered.stderr).toMatchObject({ code: 0, killed: false });
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      task: { status: "ready", checkpoint: 1 },
      calls: "A\n",
    });
    const due = await child("resume", 1000);
    expect(due, due.stderr).toMatchObject({ code: 0, killed: false });
    expect(JSON.parse(due.stdout)).toMatchObject({
      task: { status: "completed", checkpoint: 2 },
      calls: "A\nB\n",
    });
  });
});

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-task-process-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});
function child(mode: string) {
  return new Promise<{ code: number | string; killed: boolean; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [
          fileURLToPath(new URL("../../../test/fixtures/task-phases.mjs", import.meta.url)),
          workspace,
          mode,
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
describe("真实进程任务恢复", () => {
  it("A 提交后不释放租约直接退出；新进程只执行 B，终态再次打开不重做", async () => {
    expect(await child("commit-exit")).toMatchObject({ code: 23, killed: false, stderr: "" });
    const resumed = await child("resume");
    expect(resumed, resumed.stderr).toMatchObject({ code: 0, killed: false });
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      task: { phase: "b", status: "completed", checkpoint: 2 },
      calls: "A\nB\n",
    });
    const terminal = await child("resume");
    expect(terminal, terminal.stderr).toMatchObject({ code: 0, killed: false });
    expect(JSON.parse(terminal.stdout).calls).toBe("A\nB\n");
  });
  it("迁移提交后、阶段返回前退出，重启不重复迁移", async () => {
    expect(await child("start")).toMatchObject({ code: 0, killed: false });
    expect(await child("migrate-crash")).toMatchObject({ code: 23, killed: false, stderr: "" });
    const resumed = await child("migrate-resume");
    expect(resumed, resumed.stderr).toMatchObject({ code: 0, killed: false });
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      task: { version: 2, phase: "b", checkpoint: 11 },
      calls: "M\nA\n",
    });
  });
});

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointManager, inspectCheckpoint, restoreCheckpoint } from "./checkpoint.js";

describe("CheckpointManager", () => {
  it("修改既有文件前保存快照，可查看 diff 并恢复", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-checkpoint-"));
    const file = path.join(cwd, "notes.txt");
    writeFileSync(file, "修改前", "utf8");
    const manager = new CheckpointManager({
      cwd,
      rootDir: path.join(cwd, ".coremind", "checkpoints"),
      runId: "run-1",
    });

    const checkpoint = await manager.capture("edit", { path: "notes.txt" });
    writeFileSync(file, "修改后", "utf8");
    const diff = await manager.diff(checkpoint!.checkpointId);

    expect(checkpoint).toMatchObject({ reversible: true, existed: true });
    expect(diff).toMatchObject({ changed: true, beforeText: "修改前", afterText: "修改后" });

    await manager.restore(checkpoint!.checkpointId);
    expect(readFileSync(file, "utf8")).toBe("修改前");
  });

  it("新建文件的快照恢复会只删除该新文件", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-checkpoint-new-"));
    const manager = new CheckpointManager({
      cwd,
      rootDir: path.join(cwd, ".coremind", "checkpoints"),
      runId: "run-2",
    });
    const checkpoint = await manager.capture("write", { path: "new.txt" });
    writeFileSync(path.join(cwd, "new.txt"), "新文件", "utf8");

    await manager.restore(checkpoint!.checkpointId);

    expect(existsSync(path.join(cwd, "new.txt"))).toBe(false);
  });

  it("任意 shell 副作用只记录不可逆检查点，不伪装成可回退", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-checkpoint-shell-"));
    const manager = new CheckpointManager({
      cwd,
      rootDir: path.join(cwd, ".coremind", "checkpoints"),
      runId: "run-3",
    });

    const checkpoint = await manager.capture("bash", { command: "npm test" });

    expect(checkpoint).toMatchObject({ reversible: false });
    await expect(manager.restore(checkpoint!.checkpointId)).rejects.toMatchObject({
      code: "checkpoint_not_reversible",
    });
  });

  it("可通过运行结果中的记录重新查看 diff 并显式恢复", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-checkpoint-reopen-"));
    const file = path.join(cwd, "notes.txt");
    writeFileSync(file, "原始", "utf8");
    const manager = new CheckpointManager({
      cwd,
      rootDir: path.join(cwd, ".coremind", "checkpoints"),
      runId: "run-reopen",
    });
    const checkpoint = await manager.capture("edit", { path: "notes.txt" });
    writeFileSync(file, "已修改", "utf8");

    await expect(inspectCheckpoint(checkpoint!, cwd)).resolves.toMatchObject({
      changed: true,
      beforeText: "原始",
      afterText: "已修改",
    });
    await restoreCheckpoint(checkpoint!, cwd);
    expect(readFileSync(file, "utf8")).toBe("原始");
  });
});

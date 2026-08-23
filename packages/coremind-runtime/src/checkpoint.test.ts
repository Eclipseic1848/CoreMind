import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveToolCapability } from "coremind-tools";
import { describe, expect, it } from "vitest";
import { CheckpointManager, inspectCheckpoint, restoreCheckpoint } from "./checkpoint.js";

describe("CheckpointManager", () => {
  it("将 operation、工具调用与副作用幂等键写入同一检查点记录", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-checkpoint-correlation-"));
    const manager = new CheckpointManager({
      cwd,
      rootDir: path.join(cwd, ".coremind", "checkpoints"),
      runId: "run-correlation",
    });
    const record = await manager.capture(
      "write",
      { path: "linked.txt" },
      {
        operationId: "operation-correlation",
        toolCallId: "call-correlation",
        idempotencyKey: "run-correlation:call-correlation",
      },
    );

    expect(record).toMatchObject({
      runId: "run-correlation",
      operationId: "operation-correlation",
      toolCallId: "call-correlation",
      idempotencyKey: "run-correlation:call-correlation",
    });
  });

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
    await manager.markApplied(checkpoint!.checkpointId);
    const diff = await manager.diff(checkpoint!.checkpointId);

    expect(checkpoint).toMatchObject({ reversible: true, existed: true });
    expect(diff).toMatchObject({ changed: true, beforeText: "修改前", afterText: "修改后" });
    expect(diff.unifiedDiff).toContain("-修改前");
    expect(diff.unifiedDiff).toContain("+修改后");

    await manager.restore(checkpoint!.checkpointId);
    expect(readFileSync(file, "utf8")).toBe("修改前");
  });

  it("修改后的文件超过 diff 上限时拒绝生成大结果", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-checkpoint-large-"));
    writeFileSync(path.join(cwd, "large.txt"), "small", "utf8");
    const manager = new CheckpointManager({
      cwd,
      rootDir: path.join(cwd, ".coremind", "checkpoints"),
      runId: "run-large-diff",
      maxFileBytes: 16,
    });
    const checkpoint = await manager.capture("write", { path: "large.txt" });
    writeFileSync(path.join(cwd, "large.txt"), "x".repeat(32), "utf8");

    await expect(manager.diff(checkpoint!.checkpointId)).rejects.toMatchObject({
      code: "checkpoint_too_large",
    });
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
    await manager.markApplied(checkpoint!.checkpointId);

    const diff = await manager.diff(checkpoint!.checkpointId);
    expect(diff).toMatchObject({ changed: true, afterText: "新文件", reversible: true });
    expect(diff).not.toHaveProperty("beforeText");
    expect(diff.unifiedDiff).toContain("--- /dev/null");

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
    await expect(manager.diff(checkpoint!.checkpointId)).resolves.toMatchObject({
      changed: false,
      reversible: false,
    });
    await expect(manager.restore(checkpoint!.checkpointId)).rejects.toMatchObject({
      code: "checkpoint_not_reversible",
    });
  });

  it("自定义工具按 Capability 建立快照，不依赖 edit/write 名称", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-checkpoint-capability-"));
    writeFileSync(path.join(cwd, "custom.txt"), "修改前", "utf8");
    const manager = new CheckpointManager({
      cwd,
      rootDir: path.join(cwd, ".coremind", "checkpoints"),
      runId: "run-capability",
    });
    const capability = resolveToolCapability({
      tool: "custom_writer",
      source: "registered",
      declaration: {
        effect: "workspace",
        replay: "idempotent",
        concurrency: "workspace_exclusive",
        checkpoint: "required",
        durability: "critical",
      },
    });

    const checkpoint = await manager.capture(
      "custom_writer",
      { path: "custom.txt" },
      { capability },
    );

    expect(checkpoint).toMatchObject({
      tool: "custom_writer",
      reversible: true,
      existed: true,
    });
  });

  it("自定义工具为声明的全部路径字段建立快照", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-checkpoint-multiple-paths-"));
    writeFileSync(path.join(cwd, "input.csv"), "原始数据", "utf8");
    const manager = new CheckpointManager({
      cwd,
      rootDir: path.join(cwd, ".coremind", "checkpoints"),
      runId: "run-multiple-paths",
    });
    const capability = resolveToolCapability({
      tool: "analyze_sales",
      source: "registered",
      declaration: {
        effect: "workspace",
        replay: "unknown",
        concurrency: "workspace_exclusive",
        checkpoint: "required",
        durability: "critical",
      },
    });

    const checkpoints = await manager.captureAll(
      "analyze_sales",
      { csv_path: "input.csv", output_path: "summary.json" },
      { capability, pathFields: ["csv_path", "output_path"] },
    );

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.map((checkpoint) => path.basename(checkpoint.targetPath!))).toEqual([
      "input.csv",
      "summary.json",
    ]);
    expect(checkpoints.map((checkpoint) => checkpoint.existed)).toEqual([true, false]);
  });

  it("既有文件被删除后生成指向空文件的统一 diff", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-checkpoint-delete-"));
    const file = path.join(cwd, "removed.txt");
    writeFileSync(file, "待删除内容", "utf8");
    const manager = new CheckpointManager({
      cwd,
      rootDir: path.join(cwd, ".coremind", "checkpoints"),
      runId: "run-delete",
    });
    const checkpoint = await manager.capture("edit", { path: "removed.txt" });
    unlinkSync(file);
    await manager.markApplied(checkpoint!.checkpointId);

    const diff = await manager.diff(checkpoint!.checkpointId);

    expect(diff).toMatchObject({ changed: true, beforeText: "待删除内容", reversible: true });
    expect(diff).not.toHaveProperty("afterText");
    expect(diff.unifiedDiff).toContain("+++ /dev/null");
  });

  it("工具完成后文件又被修改时拒绝恢复，避免覆盖用户新内容", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-checkpoint-conflict-"));
    const file = path.join(cwd, "notes.txt");
    writeFileSync(file, "修改前", "utf8");
    const manager = new CheckpointManager({
      cwd,
      rootDir: path.join(cwd, ".coremind", "checkpoints"),
      runId: "run-conflict",
    });
    const checkpoint = await manager.capture("edit", { path: "notes.txt" });
    writeFileSync(file, "工具修改后", "utf8");
    await manager.markApplied(checkpoint!.checkpointId);
    writeFileSync(file, "用户后续修改", "utf8");

    await expect(manager.restore(checkpoint!.checkpointId)).rejects.toMatchObject({
      code: "checkpoint_conflict",
    });
    expect(readFileSync(file, "utf8")).toBe("用户后续修改");
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
    await manager.markApplied(checkpoint!.checkpointId);

    await expect(inspectCheckpoint(checkpoint!, cwd)).resolves.toMatchObject({
      changed: true,
      beforeText: "原始",
      afterText: "已修改",
    });
    await restoreCheckpoint(checkpoint!, cwd);
    expect(readFileSync(file, "utf8")).toBe("原始");
  });
});

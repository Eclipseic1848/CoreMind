import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeWorkspace,
  projectWorkspaceLeases,
  WorkspaceLeaseService,
  workspaceLeasePath,
} from "./workspace-lease.js";

describe("WorkspaceLeaseService", () => {
  it("同一 canonical Workspace 最多一个 Writer，独立 Workspace 可并行", async () => {
    const firstRoot = mkdtempSync(path.join(tmpdir(), "coremind-lease-first-"));
    const secondRoot = mkdtempSync(path.join(tmpdir(), "coremind-lease-second-"));
    const firstService = new WorkspaceLeaseService();
    const secondService = new WorkspaceLeaseService();

    const contested = await Promise.allSettled([
      firstService.acquire({
        workspaceRoot: firstRoot,
        lane: "workspace_exclusive",
        owner: { runId: "run-1", callId: "call-1" },
      }),
      secondService.acquire({
        workspaceRoot: firstRoot,
        lane: "workspace_exclusive",
        owner: { runId: "run-2", callId: "call-2" },
      }),
    ]);
    const first = contested.find((result) => result.status === "fulfilled");
    expect(contested.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(contested.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "workspace_busy" }) }),
    ]);
    const isolated = await secondService.acquire({
      workspaceRoot: secondRoot,
      lane: "workspace_exclusive",
      owner: { runId: "run-2", callId: "call-3" },
    });

    await isolated.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
    await first!.value.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
  });

  it("symlink 或 junction 与真实目录解析为同一 Workspace", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "coremind-lease-link-"));
    const realRoot = path.join(parent, "real");
    const linkedRoot = path.join(parent, "linked");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    expect(await canonicalizeWorkspace(linkedRoot)).toBe(await canonicalizeWorkspace(realRoot));
  });

  it.runIf(process.platform === "win32")("Windows 路径大小写映射到同一 Workspace", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "coremind-lease-case-"));
    expect(await canonicalizeWorkspace(root.toUpperCase())).toBe(await canonicalizeWorkspace(root));
  });

  it("Pure Local Read 不创建写锁，也不被 Writer 全局串行化", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "coremind-lease-read-"));
    const service = new WorkspaceLeaseService();
    const writer = await service.acquire({
      workspaceRoot: root,
      lane: "workspace_exclusive",
      owner: { runId: "run-write", callId: "call-write" },
    });

    const reader = await service.acquire({
      workspaceRoot: root,
      lane: "parallel",
      owner: { runId: "run-read", callId: "call-read" },
    });
    expect(reader.requiresWriteLease).toBe(false);

    await reader.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
    await writer.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
  });

  it("run_serial 只串行同一 Run，不阻断其他 Run", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "coremind-lease-run-serial-"));
    const service = new WorkspaceLeaseService();
    const first = await service.acquire({
      workspaceRoot: root,
      lane: "run_serial",
      owner: { runId: "run-1", callId: "call-1" },
    });
    await expect(
      service.acquire({
        workspaceRoot: root,
        lane: "run_serial",
        owner: { runId: "run-1", callId: "call-2" },
      }),
    ).rejects.toMatchObject({ code: "workspace_busy" });
    const independentRun = await service.acquire({
      workspaceRoot: root,
      lane: "run_serial",
      owner: { runId: "run-2", callId: "call-3" },
    });

    await independentRun.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
    await first.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
  });

  it("Owner 崩溃后必须显式审计恢复，不能静默转移", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "coremind-lease-stale-"));
    const canonicalRoot = await canonicalizeWorkspace(root);
    const lockPath = workspaceLeasePath(canonicalRoot);
    const candidatePath = path.join(path.dirname(lockPath), "workspace-write.candidate-dead-owner");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        canonicalRoot,
        runId: "dead-run",
        callId: "dead-call",
        pid: 2_147_483_647,
        nonce: "dead-owner",
        acquiredAt: "2026-08-23T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(candidatePath, "crash residue", "utf8");
    const service = new WorkspaceLeaseService();

    await expect(
      service.acquire({
        workspaceRoot: root,
        lane: "workspace_exclusive",
        owner: { runId: "new-run", callId: "new-call" },
      }),
    ).rejects.toMatchObject({ code: "workspace_lease_recovery_required" });
    const inspection = await service.inspect(root);
    expect(inspection).toMatchObject({
      state: "recovery_required",
      owner: { nonce: "dead-owner" },
    });

    const decision = await service.recover(root, "dead-owner");
    expect(decision).toMatchObject({ state: "recovered", previousOwner: { runId: "dead-run" } });
    expect(existsSync(candidatePath)).toBe(false);
    const acquired = await service.acquire({
      workspaceRoot: root,
      lane: "workspace_exclusive",
      owner: { runId: "new-run", callId: "new-call" },
    });
    await acquired.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
  });

  it("Owner canonical root 与锁路径不一致时按损坏租约处理", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "coremind-lease-owner-root-"));
    const canonicalRoot = await canonicalizeWorkspace(root);
    const lockPath = workspaceLeasePath(canonicalRoot);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        canonicalRoot: `${canonicalRoot}-other`,
        runId: "run-mismatch",
        callId: "call-mismatch",
        pid: process.pid,
        nonce: "mismatched-root",
        acquiredAt: "2026-08-23T00:00:00.000Z",
      }),
      "utf8",
    );

    expect(await new WorkspaceLeaseService().inspect(root)).toMatchObject({
      state: "recovery_required",
      reason: expect.stringContaining("canonical root"),
    });
  });

  it("关键尾部未静止时拒绝释放，Owner 仍保持不变", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "coremind-lease-quiescence-"));
    const service = new WorkspaceLeaseService();
    const lease = await service.acquire({
      workspaceRoot: root,
      lane: "workspace_exclusive",
      owner: { runId: "run-1", callId: "call-1" },
    });

    await expect(
      lease.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 1 }),
    ).rejects.toMatchObject({ code: "workspace_lease_not_quiescent" });
    expect(await service.inspect(root)).toMatchObject({
      state: "held",
      owner: { runId: "run-1", callId: "call-1" },
    });

    await lease.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
    expect(await service.inspect(root)).toEqual({
      state: "available",
      canonicalRoot: await canonicalizeWorkspace(root),
    });
  });

  it("工具执行前失败可回滚租约，不要求伪造已静止的关键尾部", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "coremind-lease-rollback-"));
    const service = new WorkspaceLeaseService();
    const lease = await service.acquire({
      workspaceRoot: root,
      lane: "workspace_exclusive",
      owner: { runId: "run-rollback", callId: "call-rollback" },
    });

    await lease.rollbackBeforeExecution();

    expect((await service.inspect(root)).state).toBe("available");
    await expect(lease.rollbackBeforeExecution()).rejects.toMatchObject({
      code: "workspace_lease_invalid",
    });
  });

  it("1,000 个固定竞争请求不会产生双 Writer 或锁泄漏", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "coremind-lease-race-"));
    const holder = await new WorkspaceLeaseService().acquire({
      workspaceRoot: root,
      lane: "workspace_exclusive",
      owner: { runId: "holder", callId: "holder-call" },
    });
    let busyCount = 0;
    // 1 个已持有请求 + 999 个固定竞争请求；分批读取 owner，避免测试耗尽全局文件线程池。
    for (let round = 0; round < 100; round += 1) {
      const batchSize = round === 99 ? 9 : 10;
      const services = Array.from({ length: batchSize }, () => new WorkspaceLeaseService());
      const settled = await Promise.allSettled(
        services.map((service, index) =>
          service.acquire({
            workspaceRoot: root,
            lane: "workspace_exclusive",
            owner: { runId: `run-${round}-${index}`, callId: `call-${round}-${index}` },
          }),
        ),
      );
      busyCount += settled.filter(
        (result) =>
          result.status === "rejected" &&
          (result.reason as { code?: string }).code === "workspace_busy",
      ).length;
      expect(settled.every((result) => result.status === "rejected")).toBe(true);
    }
    expect(busyCount).toBe(999);
    await holder.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
    expect((await new WorkspaceLeaseService().inspect(root)).state).toBe("available");
  });

  it("Lease Fact 投影要求 acquired→released Owner 一致，缺失历史 Fact 不伪造", () => {
    const acquired = {
      type: "workspace_lease" as const,
      status: "acquired" as const,
      canonicalRoot: "/workspace",
      lane: "workspace_exclusive" as const,
      owner: { runId: "run-1", callId: "call-1", pid: 123 },
      agent: "main",
      callId: "call-1",
    };
    expect(projectWorkspaceLeases([])).toEqual([]);
    expect(projectWorkspaceLeases([acquired, { ...acquired, status: "released" }])).toEqual([
      expect.objectContaining({
        callId: "call-1",
        status: "released",
        canonicalRoot: "/workspace",
      }),
    ]);
    expect(() =>
      projectWorkspaceLeases([
        acquired,
        { ...acquired, status: "released", owner: { ...acquired.owner, runId: "other" } },
      ]),
    ).toThrowError(expect.objectContaining({ code: "workspace_lease_invalid" }));
  });
});

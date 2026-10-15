import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { FileRunStore, type RunStateRecord } from "./run-state.js";

const observed = vi.hoisted(() => ({
  barriers: [] as Array<{ kind: "writeFile.flush" | "sync"; file: string }>,
  owners: [] as Array<{ pid: number; nonce: string; createdAt: string }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args);
      if (typeof args[2] === "object" && args[2]?.flush)
        observed.barriers.push({ kind: "writeFile.flush", file: String(args[0]) });
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        observed.barriers.push({ kind: "sync", file: String(args[0]) });
      };
      return handle;
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      // 只观察发布前的真实 owner，仍由原硬链接操作竞争唯一锁。
      observed.owners.push(JSON.parse(await actual.readFile(args[0], "utf8")));
      await actual.link(...args);
    },
  };
});

it("ordinary 锁仅原子发布完整 owner，critical Fact 才执行真实磁盘屏障", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "coremind-lock-durability-"));
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith("coremind-lock-durability-")
  )
    throw new Error("拒绝清理不属于锁持久化测试的目录");
  observed.barriers.length = 0;
  observed.owners.length = 0;
  try {
    const runId = "run-lock-durability";
    const store = new FileRunStore(directory);
    const records = Array.from(
      { length: 4 },
      (_, index): RunStateRecord => ({
        version: 1,
        runId,
        sequence: index + 1,
        eventId: `lock-durability-${index + 1}`,
        timestamp: "2026-10-15T00:00:00.000Z",
        kind: index === 0 ? "start" : "event",
        payload: { ordinal: index + 1 },
      }),
    );
    for (const record of records.slice(0, 3)) await store.append(record);
    expect(await store.read(runId)).toEqual(records.slice(0, 3));
    expect(observed.barriers).toEqual([]);

    expect(await store.commit(records[3]!, "critical")).toEqual({
      requested: "critical",
      achieved: "critical",
      boundary: "process_crash",
    });
    expect(await store.read(runId)).toEqual(records);
    expect(observed.barriers).toHaveLength(1);
    expect(observed.barriers[0]!.kind).toBe("sync");
    const synced = observed.barriers[0]!.file;
    expect(path.dirname(synced)).toBe(directory);
    expect(path.basename(synced)).toMatch(
      new RegExp(`^${runId}\\.jsonl\\.${process.pid}\\.[0-9a-f-]+\\.tmp$`, "u"),
    );
    expect(observed.owners).toHaveLength(6);
    for (const owner of observed.owners) {
      expect(owner).toEqual({
        pid: process.pid,
        nonce: expect.any(String),
        createdAt: expect.any(String),
      });
      expect(owner.nonce).not.toBe("");
    }
    expect(new Set(observed.owners.map((owner) => owner.nonce)).size).toBe(6);
    expect(readdirSync(directory)).toEqual([`${runId}.jsonl`]);
  } finally {
    rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

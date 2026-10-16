import type { Stats } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { FileRunStore, type RunStateRecord } from "./run-state.js";

const io = vi.hoisted(() => ({
  file: "",
  frozen: undefined as Stats | undefined,
  reads: 0,
  failAppend: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === io.file && args[1] === "a") {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (data, options) => {
          if (io.failAppend && typeof data === "string") {
            io.failAppend = false;
            await write(data.slice(0, 25), "utf8");
            throw Object.assign(new Error("注入追加部分写失败"), { code: "EIO" });
          }
          return write(data, options);
        };
      }
      return handle;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === io.file) io.reads += 1;
      return actual.readFile(...args);
    },
    stat: async (...args: Parameters<typeof actual.stat>) =>
      String(args[0]) === io.file && io.frozen ? io.frozen : actual.stat(...args),
  };
});

function record(runId: string, sequence: number, value = "原始"): RunStateRecord {
  return {
    version: 1,
    runId,
    sequence,
    eventId: `${runId}-${sequence}`,
    timestamp: "2026-10-16T00:00:00.000Z",
    kind: sequence === 1 ? "start" : "event",
    payload: { value },
  };
}

function observePrefix(runId: string, nextSequence: number) {
  const cost = { parsed: 0, serialized: 0 };
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    const value = parse(text, reviver);
    if (value?.runId === runId && value.sequence < nextSequence) cost.parsed += 1;
    return value;
  });
  vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
    const entry = value as Partial<RunStateRecord> | undefined;
    if (entry?.runId === runId && (entry.sequence ?? Infinity) < nextSequence) cost.serialized += 1;
    // 原样转发函数或数组 replacer，避免取单个 overload 后缩窄原函数行为。
    return Reflect.apply(stringify, JSON, [value, replacer, space]) as string;
  });
  return cost;
}

async function withStore(action: (store: FileRunStore, directory: string) => Promise<void>) {
  const root = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(root, "coremind-prefix-cache-"));
  try {
    await action(new FileRunStore(directory), directory);
  } finally {
    vi.restoreAllMocks();
    io.file = "";
    io.frozen = undefined;
    io.reads = 0;
    io.failAppend = false;
    expect(path.dirname(path.resolve(directory))).toBe(root);
    expect(path.basename(directory).startsWith("coremind-prefix-cache-")).toBe(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

it("热 critical 保留全文读取，避免再次解析和序列化已确认前缀", async () => {
  await withStore(async (store) => {
    const runId = "run-prefix-cost";
    const original = Array.from({ length: 64 }, (_, i) => record(runId, i + 1, "汉字".repeat(128)));
    await writeFile(
      store.pathFor(runId),
      original.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      "utf8",
    );
    await store.commit(record(runId, 65), "critical");
    io.file = store.pathFor(runId);
    const cost = observePrefix(runId, 66);
    await store.commit(record(runId, 66), "critical");
    expect(cost).toEqual({ parsed: 0, serialized: 0 });
    expect(io.reads).toBe(1);
    vi.restoreAllMocks();
    expect(await store.read(runId)).toEqual([...original, record(runId, 65), record(runId, 66)]);
  });
});

it("同 stat 的外部真实改写在 critical 仍被全文复核", async () => {
  await withStore(async (store) => {
    const runId = "run-prefix-modified";
    await store.commit(record(runId, 1), "critical");
    io.file = store.pathFor(runId);
    io.frozen = await stat(io.file);
    const changed = record(runId, 1, "改写");
    const before = await readFile(io.file, "utf8");
    const text = `${JSON.stringify(changed)}\n`;
    expect(Buffer.byteLength(text)).toBe(Buffer.byteLength(before));
    await writeFile(io.file, text, "utf8");
    await expect(store.commit(record(runId, 1), "critical")).rejects.toMatchObject({
      code: "run_state_conflict",
    });
    expect(await readFile(io.file, "utf8")).toBe(text);
    await writeFile(io.file, text.replace('"sequence":1', '"sequence":9'), "utf8");
    await expect(store.commit(record(runId, 2), "critical")).rejects.toMatchObject({
      code: "run_state_corrupt",
    });
  });
});

it("UTF-8 前缀总预算淘汰旧文本，较新 Run 仍能复用且读取完整", async () => {
  await withStore(async (store) => {
    const value = "汉".repeat(512 * 1024);
    for (const runId of ["prefix-old", "prefix-middle", "prefix-recent"])
      await store.commit(record(runId, 1, value), "critical");
    let cost = observePrefix("prefix-old", 2);
    await store.commit(record("prefix-old", 2), "critical");
    expect(cost.parsed).toBeGreaterThan(0);
    expect(cost.serialized).toBeGreaterThan(0);
    vi.restoreAllMocks();
    cost = observePrefix("prefix-recent", 2);
    await store.commit(record("prefix-recent", 2), "critical");
    expect(cost).toEqual({ parsed: 0, serialized: 0 });
    vi.restoreAllMocks();
    expect((await store.read("prefix-old"))[0]!.payload).toEqual({ value });
    expect(await store.read("prefix-recent")).toEqual([
      record("prefix-recent", 1, value),
      record("prefix-recent", 2),
    ]);
  });
});

it("提交失败清除热前缀，重试重新复核原数据并保持关键屏障", async () => {
  await withStore(async (_, directory) => {
    let fail = false;
    let barriers = 0;
    const store = new FileRunStore(directory, {
      beforeBarrier: async () => {
        barriers += 1;
        if (fail) throw new Error("注入磁盘屏障失败");
      },
    });
    const runId = "prefix-failed";
    await store.commit(record(runId, 1), "critical");
    fail = true;
    await expect(store.commit(record(runId, 2), "critical")).rejects.toThrow();
    fail = false;
    const cost = observePrefix(runId, 2);
    await store.commit(record(runId, 2), "critical");
    expect(cost.parsed).toBeGreaterThan(0);
    vi.restoreAllMocks();
    await store.commit(record(runId, 2), "critical");
    expect(barriers).toBe(4);
    expect(await store.read(runId)).toEqual([record(runId, 1), record(runId, 2)]);
  });
});

it("已有 critical 前缀经 ordinary 追加后仍可复用，追加本身不读取历史", async () => {
  await withStore(async (store) => {
    const runId = "prefix-ordinary";
    const records = [record(runId, 1), record(runId, 2), record(runId, 3)];
    await store.commit(records[0]!, "critical");
    io.file = store.pathFor(runId);
    await store.append(records[1]!);
    expect(io.reads).toBe(0);
    const cost = observePrefix(runId, 3);
    await store.commit(records[2]!, "critical");
    expect(cost).toEqual({ parsed: 0, serialized: 0 });
    expect(io.reads).toBe(1);
    vi.restoreAllMocks();
    expect(await readFile(io.file, "utf8")).toBe(
      records.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
    expect(await store.read(runId)).toEqual(records);
  });
});

it("单个 UTF-8 前缀超预算时 critical 回退，后续 ordinary 仍只追加", async () => {
  await withStore(async (store) => {
    const runId = "prefix-oversized";
    const first = record(runId, 1, "🙂".repeat(1024 * 1024 + 1));
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeGreaterThan(4 * 1024 * 1024);
    await store.commit(first, "critical");
    const cost = observePrefix(runId, 2);
    await store.commit(record(runId, 2), "critical");
    expect(cost.parsed).toBeGreaterThan(0);
    expect(cost.serialized).toBeGreaterThan(0);
    vi.restoreAllMocks();
    io.file = store.pathFor(runId);
    await store.append(record(runId, 3));
    await store.append(record(runId, 4));
    expect(io.reads).toBe(0);
    expect(await store.read(runId)).toEqual([
      first,
      record(runId, 2),
      record(runId, 3),
      record(runId, 4),
    ]);
  });
});

it("64 游标上限淘汰最久未提交者，刚刷新者保留热前缀", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 64; i++) await store.commit(record(`cursor-${i}`, 1), "critical");
    await store.commit(record("cursor-0", 2), "critical");
    await store.commit(record("cursor-64", 1), "critical");
    let cost = observePrefix("cursor-0", 3);
    await store.commit(record("cursor-0", 3), "critical");
    expect(cost).toEqual({ parsed: 0, serialized: 0 });
    vi.restoreAllMocks();
    cost = observePrefix("cursor-1", 2);
    await store.commit(record("cursor-1", 2), "critical");
    expect(cost.parsed).toBeGreaterThan(0);
    expect(cost.serialized).toBeGreaterThan(0);
    vi.restoreAllMocks();
    expect(await store.read("cursor-0")).toEqual([
      record("cursor-0", 1),
      record("cursor-0", 2),
      record("cursor-0", 3),
    ]);
    expect(await store.read("cursor-1")).toEqual([record("cursor-1", 1), record("cursor-1", 2)]);
  });
});

it("ordinary 真实部分写失败后，旧 Store critical 重试恢复稳定前缀且序号不重放", async () => {
  await withStore(async (store) => {
    const runId = "prefix-partial-failure";
    const first = record(runId, 1);
    await store.commit(first, "critical");
    io.file = store.pathFor(runId);
    const prefix = await readFile(io.file, "utf8");
    io.failAppend = true;
    await expect(store.append(record(runId, 2))).rejects.toMatchObject({
      code: "run_state_failed",
    });
    const broken = await readFile(io.file, "utf8");
    expect(broken.startsWith(prefix)).toBe(true);
    expect(broken.length).toBeGreaterThan(prefix.length);
    expect(broken.endsWith("\n")).toBe(false);
    const cost = observePrefix(runId, 2);
    await store.commit(record(runId, 2), "critical");
    expect(cost.parsed).toBeGreaterThan(0);
    vi.restoreAllMocks();
    await store.append(record(runId, 3));
    expect(await store.read(runId)).toEqual([first, record(runId, 2), record(runId, 3)]);
    expect(await readFile(io.file, "utf8")).toBe(
      [first, record(runId, 2), record(runId, 3)]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
    );
  });
});

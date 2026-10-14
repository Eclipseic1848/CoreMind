import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CoreMindSession } from "./session.js";
import {
  createCompactionSummaryMessage,
  InMemorySessionRepo,
  JsonlSessionRepo,
  SessionFileSystem,
  type SessionRepo,
} from "./session-v4/index.js";
import { createSessionBackendConformance } from "./session-v4/session/testing/conformance.js";
import type { SessionBackendFixture } from "./session-v4/session/testing/types.js";

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "coremind-session-full-contract-"));
}

function jsonlRepository(dir: string): JsonlSessionRepo {
  return new JsonlSessionRepo({ fs: new SessionFileSystem({ cwd: dir }), sessionsRoot: dir });
}

function withDefaultCwd(repository: SessionRepo, cwd: string): SessionRepo {
  return {
    create: (options) => repository.create({ ...options, cwd }),
    open: (metadata) => repository.open(metadata),
    list: () => repository.list(),
    delete: (metadata) => repository.delete(metadata),
    fork: (source, options) => repository.fork(source, { ...options, cwd }),
  };
}

const backends = [
  {
    name: "内存",
    create: async (): Promise<SessionBackendFixture> => ({
      repository: new InMemorySessionRepo(),
      [Symbol.asyncDispose]: async () => {},
    }),
  },
  {
    name: "JSONL",
    create: async (): Promise<SessionBackendFixture> => {
      const dir = temporaryDirectory();
      return {
        repository: withDefaultCwd(jsonlRepository(dir), dir),
        [Symbol.asyncDispose]: async () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  },
];

describe.each(backends)("完整会话后端合同：$name", ({ create }) => {
  const cases = createSessionBackendConformance(create);
  it("完整注册全部二十九个合同场景", () => expect(cases).toHaveLength(29));
  for (const scenario of cases) {
    it(`${scenario.group}: ${scenario.name}`, () => scenario.run());
  }
});

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const toolMessage = {
  role: "assistant" as const,
  content: [
    {
      type: "toolCall" as const,
      id: "call-fixed",
      name: "inspect",
      arguments: {
        filter: { names: ["中文", "second"], active: true, optional: null },
        schema: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
      },
    },
  ],
  api: "openai-completions",
  provider: "fixture",
  model: "fixture-model",
  stopReason: "toolUse" as const,
  usage,
  timestamp: 2,
};
const toolResult = {
  role: "toolResult" as const,
  toolCallId: "call-fixed",
  toolName: "inspect",
  content: [{ type: "text" as const, text: "合法结果" }],
  details: { result: [0, false, null, { value: "中文" }] },
  isError: false,
  timestamp: 3,
};

describe("历史会话固定金样", () => {
  it.each([true, false])("V4 损坏记录：仅撕裂尾可修复（位于尾部：%s）", async (atTail) => {
    const dir = temporaryDirectory();
    try {
      const repository = jsonlRepository(dir);
      const created = await repository.create({ id: "corruption-fixture", cwd: dir });
      const metadata = await created.getMetadata();
      const header = `${JSON.stringify({ kind: "header", version: 4, id: metadata.id, createdAt: 1, cwd: dir })}\n`;
      const message = `${JSON.stringify({ kind: "entry", lane: "main", type: "message", id: "root", seq: 1, parentId: null, timestamp: 1, message: user("完整前缀") })}\n`;
      const validPrefix = header + message;
      const original = atTail ? `${validPrefix}{"kind":` : `${header}{"kind":\n${message}`;
      writeFileSync(metadata.path, original, "utf8");
      if (atTail) {
        const recovered = await repository.open(metadata);
        expect(
          (await recovered.findEntriesOnBranch({ order: "oldestFirst" })).map((entry) => entry.id),
        ).toEqual(["root"]);
        expect(readFileSync(metadata.path, "utf8")).toBe(validPrefix);
      } else {
        await expect(repository.open(metadata)).rejects.toMatchObject({ code: "invalid_entry" });
        expect(readFileSync(metadata.path, "utf8")).toBe(original);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("V4 原字节、分支水位、工具参数和压缩视图在重新打开后保持", async () => {
    const dir = temporaryDirectory();
    try {
      const repository = jsonlRepository(dir);
      const created = await repository.create({ id: "golden-v4", cwd: dir });
      const metadata = await created.getMetadata();
      const entry = (id: string, seq: number, parentId: string | null, data: object) => ({
        kind: "entry",
        lane: "main",
        id,
        seq,
        parentId,
        timestamp: seq,
        ...data,
      });
      const retained = user("保留的尾部");
      const current = user("压缩后的新输入");
      const records = [
        { kind: "header", version: 4, id: "golden-v4", createdAt: 1, cwd: dir },
        entry("root", 1, null, { type: "message", message: user("最初输入") }),
        entry("assistant", 2, "root", { type: "message", message: toolMessage }),
        entry("result", 3, "assistant", { type: "message", message: toolResult }),
        entry("maintenance", 4, "result", {
          type: "custom",
          customType: "coremind.session-maintenance.v1",
          data: { status: "unchanged", requestId: "request-fixed" },
        }),
        entry("compacted", 5, "maintenance", {
          type: "compaction",
          summary: "固定摘要",
          retainedTail: [retained],
          tokensBefore: 500,
        }),
        { kind: "lane", lane: "thread", seq: 6, leafId: "root" },
        {
          ...entry("branch", 7, "root", { type: "message", message: user("分支输入") }),
          lane: "thread",
        },
        entry("current", 8, "compacted", { type: "message", message: current }),
      ];
      const original = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
      writeFileSync(metadata.path, original, "utf8");
      const opened = await CoreMindSession.open({ dir, sessionId: "golden-v4", cwd: dir });
      expect(readFileSync(metadata.path, "utf8")).toBe(original);
      expect(readFileSync(opened.filePath, "utf8")).toBe(original);
      expect(
        (await opened.branchEntries()).map(({ id, seq, parentId }) => ({ id, seq, parentId })),
      ).toEqual(
        records
          .filter((record) => record.kind === "entry" && record.lane === "main")
          .map(({ id, seq, parentId }) => ({ id, seq, parentId })),
      );
      expect((await opened.branchEntries()).find((item) => item.id === "assistant")).toMatchObject({
        message: toolMessage,
      });
      expect((await opened.branchEntries()).find((item) => item.id === "result")).toMatchObject({
        message: toolResult,
      });
      expect((await opened.buildContext()).messages).toEqual([
        createCompactionSummaryMessage("固定摘要", 500, 5),
        retained,
        current,
      ]);
      expect(await opened.currentSeq()).toBe(8);
      const reopened = await CoreMindSession.open({ dir, sessionId: "golden-v4", cwd: dir });
      expect(await reopened.branchEntries()).toEqual(await opened.branchEntries());
      expect(readFileSync(metadata.path, "utf8")).toBe(original);
      const previousEntries = await reopened.branchEntries();
      const appended = user("恢复后继续的输入");
      await reopened.appendMessages([appended]);
      const continued = await CoreMindSession.open({ dir, sessionId: "golden-v4", cwd: dir });
      expect(await continued.currentSeq()).toBe(9);
      expect(await continued.branchEntries()).toEqual([
        ...previousEntries,
        expect.objectContaining({
          type: "message",
          seq: 9,
          parentId: "current",
          message: appended,
        }),
      ]);
      const originalBytes = Buffer.from(original, "utf8");
      expect(readFileSync(metadata.path).subarray(0, originalBytes.length)).toEqual(originalBytes);
      expect((await continued.buildContext()).messages).toEqual([
        createCompactionSummaryMessage("固定摘要", 500, 5),
        retained,
        current,
        appended,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("V3 迁移保留源字节备份、固定 ID 和完整工具值，重复打开不重写", async () => {
    const dir = temporaryDirectory();
    try {
      const file = path.join(dir, "golden-v3.jsonl");
      const records = [
        {
          type: "session",
          version: 3,
          id: "golden-v3",
          timestamp: "2026-08-10T00:00:00.000Z",
          cwd: dir,
        },
        {
          type: "message",
          id: "root",
          parentId: null,
          timestamp: "2026-08-10T00:00:01.000Z",
          message: user("原始输入"),
        },
        {
          type: "message",
          id: "call",
          parentId: "root",
          timestamp: "2026-08-10T00:00:02.000Z",
          message: toolMessage,
        },
        {
          type: "message",
          id: "result",
          parentId: "call",
          timestamp: "2026-08-10T00:00:03.000Z",
          message: toolResult,
        },
      ];
      const original = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
      writeFileSync(file, original, "utf8");
      const opened = await CoreMindSession.open({ dir, sessionId: "golden-v3", cwd: dir });
      expect(readFileSync(`${file}.v3.backup`, "utf8")).toBe(original);
      expect((await opened.branchEntries()).map(({ id, seq }) => ({ id, seq }))).toEqual([
        { id: "root", seq: 1 },
        { id: "call", seq: 2 },
        { id: "result", seq: 3 },
      ]);
      expect((await opened.buildContext()).messages).toEqual([
        user("原始输入"),
        toolMessage,
        toolResult,
      ]);
      const migrated = readFileSync(file, "utf8");
      const reopened = await CoreMindSession.open({ dir, sessionId: "golden-v3", cwd: dir });
      expect(readFileSync(file, "utf8")).toBe(migrated);
      const previousEntries = await reopened.branchEntries();
      const appended = user("迁移后继续的输入");
      await reopened.appendMessages([appended]);
      const continued = await CoreMindSession.open({ dir, sessionId: "golden-v3", cwd: dir });
      expect(await continued.currentSeq()).toBe(4);
      expect(await continued.branchEntries()).toEqual([
        ...previousEntries,
        expect.objectContaining({ type: "message", seq: 4, parentId: "result", message: appended }),
      ]);
      const migratedBytes = Buffer.from(migrated, "utf8");
      expect(readFileSync(file).subarray(0, migratedBytes.length)).toEqual(migratedBytes);
      expect(readFileSync(`${file}.v3.backup`)).toEqual(Buffer.from(original, "utf8"));
      expect((await continued.buildContext()).messages).toEqual([
        user("原始输入"),
        toolMessage,
        toolResult,
        appended,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TaskCommit, TaskCommitSession } from "./task-commit.js";

let workspace: string;
let temporaryRoot: string;
const schemas = [{ type: "progress", version: 1, schema: { type: "integer" } }];
const transaction: TaskCommit = {
  schemaVersion: 1,
  commitId: "a",
  expectedRevision: 0,
  taskId: "job",
  task: { type: "example", version: 1, phase: "a", checkpoint: 1 },
  documents: [{ id: "progress", type: "progress", version: 1, value: 1 }],
  entries: [{ id: "entry-a", role: "assistant", text: "A" }],
};
beforeEach(async () => {
  temporaryRoot = await realpath(tmpdir());
  workspace = await mkdtemp(path.join(temporaryRoot, "coremind-task-crash-"));
});
afterEach(async () => {
  expect(path.dirname(workspace)).toBe(temporaryRoot);
  expect(path.basename(workspace)).toMatch(/^coremind-task-crash-/u);
  await rm(workspace, { recursive: true, force: true });
});

async function open() {
  return TaskCommitSession.open({ workspace, sessionId: "crash", documentSchemas: schemas });
}

async function child(mode: "before" | "after" | "competing") {
  const moduleUrl = new URL("../dist/task-commit.js", import.meta.url).href;
  const storeUrl = new URL("../dist/run-state.js", import.meta.url).href;
  const next: TaskCommit = {
    ...transaction,
    commitId: "b",
    expectedRevision: 1,
    task: { ...transaction.task, phase: "b", checkpoint: 2 },
    documents: [{ id: "progress", type: "progress", version: 1, value: 2 }],
    entries: [{ id: "entry-b", role: "assistant", text: "B" }],
  };
  const source = [
    `const { TaskCommitSession } = await import(${JSON.stringify(moduleUrl)});`,
    `const { FileRunStore } = await import(${JSON.stringify(storeUrl)});`,
    `const mode = ${JSON.stringify(mode)};`,
    "try {",
    "  const session = await TaskCommitSession.open({",
    `    workspace: ${JSON.stringify(workspace)}, sessionId: 'crash',`,
    `    documentSchemas: ${JSON.stringify(schemas)},`,
    "    store(directory) {",
    "      const store = new FileRunStore(directory, { beforeCommit() { if (mode === 'before') process.exit(23); } });",
    "      const commit = store.commit.bind(store);",
    "      store.commit = async (...args) => { const receipt = await commit(...args); if (mode === 'after') process.exit(23); return receipt; };",
    "      return store;",
    "    },",
    "  });",
    `  await session.commit(${JSON.stringify(next)});`,
    "  await session.close();",
    "  process.exitCode = 0;",
    "} catch (error) { process.stdout.write(String(error.code)); process.exitCode = 24; }",
  ].join("\n");
  return new Promise<{
    code: number | string | undefined;
    killed: boolean;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error?.code ?? 0,
          killed: error?.killed ?? false,
          stdout,
          stderr,
        }),
    );
  });
}

describe("真实子进程的任务提交崩溃窗口", () => {
  it.each(["before", "after"] as const)("%s：重开只得到旧事务或完整新事务", async (mode) => {
    const session = await open();
    await session.commit(transaction);
    await session.close();
    const exited = await child(mode);
    expect(exited, exited.stderr).toMatchObject({ code: 23, killed: false });
    const restored = await open();
    try {
      const state = restored.snapshot();
      const after = mode === "after";
      expect(state.revision).toBe(after ? 2 : 1);
      expect(state.tasks.job!.phase).toBe(after ? "b" : "a");
      expect(state.documents.progress!.value).toBe(after ? 2 : 1);
      expect(state.entries.map((entry) => entry.text)).toEqual(after ? ["A", "B"] : ["A"]);
      await restored.commit({
        ...transaction,
        commitId: "continued",
        expectedRevision: state.revision,
        entries: [],
      });
      expect(restored.snapshot().revision).toBe(state.revision + 1);
    } finally {
      await restored.close();
    }
  });

  it("第二进程不能取得存活 writer 的同一任务目录", async () => {
    const session = await open();
    try {
      await session.commit(transaction);
      expect(await child("competing")).toMatchObject({
        code: 24,
        killed: false,
        stdout: "session_write_locked",
      });
      expect(session.snapshot().revision).toBe(1);
    } finally {
      await session.close();
    }
  });
});

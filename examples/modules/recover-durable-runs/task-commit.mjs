import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskCommitSession } from "coremind-runtime/internal";

// 只使用本次创建的临时工作区，不接入 Provider 或现有业务数据。
const temporaryRoot = await realpath(tmpdir());
const workspace = await mkdtemp(path.join(temporaryRoot, "coremind-task-example-"));
const options = {
  workspace,
  sessionId: "example",
  documentSchemas: [{ type: "progress", version: 1, schema: { type: "integer", minimum: 0 } }],
};
const commit = {
  schemaVersion: 1,
  commitId: "save-progress-1",
  expectedRevision: 0,
  taskId: "job",
  task: { type: "example", version: 1, phase: "saved", checkpoint: { completed: 1 } },
  documents: [{ id: "progress", type: "progress", version: 1, value: 1 }],
  entries: [{ id: "entry-1", role: "assistant", text: "进度已持久提交" }],
};
let session;
try {
  session = await TaskCommitSession.open(options);
  const receipt = await session.commit(commit);
  assert.equal(receipt.durabilityBoundary, "process_crash");
  const saved = session.snapshot();
  assert.deepEqual(saved, {
    revision: 1,
    tasks: { job: commit.task },
    documents: { progress: commit.documents[0] },
    entries: commit.entries,
  });
  await session.close();
  session = await TaskCommitSession.open(options);
  assert.deepEqual(session.snapshot(), saved);
  assert.deepEqual(await session.commit(commit), receipt);
  await assert.rejects(
    session.commit({ ...commit, taskId: "changed-job" }),
    (error) => error.code === "task_commit_conflict",
  );
  assert.deepEqual(session.snapshot(), saved);
  console.log(
    "TaskCommit OK: atomic projection, reopen, idempotency, conflict; no Provider calls.",
  );
} finally {
  await session?.close();
  // 删除前核验绝对目录，只清理本次 mkdtemp 创建的演示数据。
  assert.equal(path.dirname(workspace), temporaryRoot);
  assert.match(path.basename(workspace), /^coremind-task-example-/u);
  await rm(workspace, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskSession } from "coremind-ai";

const workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-phases-example-"));
const definition = {
  type: "counter",
  version: 1,
  initialPhase: "a",
  checkpointSchema: { type: "integer" },
  phases: {
    a: ({ task }) => ({ phase: "b", checkpoint: task.checkpoint + 1 }),
    b: ({ task }) => ({ phase: "b", checkpoint: task.checkpoint + 1, done: true }),
  },
};
let session;
try {
  session = await TaskSession.open({ workspace, sessionId: "demo", definitions: [definition] });
  await session.start({ taskId: "job", type: "counter", checkpoint: 0 });
  await session.start({ taskId: "migration", type: "counter", checkpoint: 0 });
  assert.equal((await session.resume("job")).phase, "b");
  await session.close();

  session = await TaskSession.open({ workspace, sessionId: "demo", definitions: [definition] });
  assert.equal((await session.resume("job")).checkpoint, 2);
  assert.equal((await session.resume("job")).status, "completed");
  await session.close();

  const updated = {
    ...definition,
    version: 2,
    migrate: (previous) => ({ phase: previous.phase, checkpoint: previous.checkpoint + 10 }),
  };
  session = await TaskSession.open({ workspace, sessionId: "demo", definitions: [updated] });
  assert.equal((await session.resume("migration")).checkpoint, 11);
  assert.equal((await session.resume("migration")).checkpoint, 12);
  assert.equal(session.query("migration").version, 2);
  console.log("Task phases and migration OK");
} finally {
  await session?.close();
  // 只清理本示例在系统临时目录创建的独立工作区。
  await rm(workspace, { recursive: true, force: true });
}

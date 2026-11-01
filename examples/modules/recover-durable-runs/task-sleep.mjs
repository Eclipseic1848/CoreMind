import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskSession } from "coremind-ai";

const workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-sleep-example-"));
const definitions = [
  {
    type: "alarm-demo",
    version: 1,
    initialPhase: "a",
    checkpointSchema: { type: "integer" },
    phases: {
      a: () => ({ phase: "b", checkpoint: 1, sleepUntil: Date.now() + 30 }),
      b: () => ({ phase: "b", checkpoint: 2, done: true }),
    },
  },
];
let session;
try {
  session = await TaskSession.open({ workspace, sessionId: "demo", definitions });
  await session.start({ taskId: "job", type: "alarm-demo", checkpoint: 0 });
  await session.resume("job");
  assert.equal(session.query("job").status, "sleeping");
  await session.close();
  session = await TaskSession.open({ workspace, sessionId: "demo", definitions });

  // 新宿主从持久期限重建 alarm；单次 timer 上限避免长期限在 Node 中溢出。
  for (let next = session.nextWake(); next; next = session.nextWake()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(next.remainingMs, 2_147_483_647)));
    const result = await session.wake(next.taskId, `alarm-${next.sleepId}`, next.sleepId);
    // 唤醒确认只表示可运行；下一阶段仍由宿主显式驱动。
    if (result.status === "accepted") await session.resume(next.taskId);
  }
  assert.equal(session.query("job").status, "completed");
  assert.equal(session.query("job").checkpoint, 2);
  console.log("Durable sleep and host alarm OK");
} finally {
  await session?.close();
  // 只清理示例创建的独立临时目录。
  await rm(workspace, { recursive: true, force: true });
}

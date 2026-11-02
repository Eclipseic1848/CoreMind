import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskSession } from "coremind-ai";
import { taskExample } from "../embed-coremind-python/task-host.mjs";

const [stage, directory] = process.argv.slice(2);
if (stage) {
  assert.ok(stage === "a" || stage === "b");
  const options = taskExample(directory);
  const session = await TaskSession.open({
    ...options,
    workspace: directory,
    sessionId: "example",
    runtime: {
      ...options.runtime,
      configDir: directory,
      env: { COREMIND_TASK_EXAMPLE_KEY: "offline-test-only" },
      config: {
        schemaVersion: 2,
        name: "离线任务重启",
        provider: {
          id: "example",
          model: "unused",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKeyEnv: "COREMIND_TASK_EXAMPLE_KEY",
        },
        agents: { main: {} },
        permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
        runtime: { maxToolCalls: 1, maxRetries: 0 },
      },
    },
  });
  try {
    if (stage === "a") {
      await session.start({ taskId: "job", type: "example", checkpoint: 0 });
      assert.equal((await session.resume("job")).status, "sleeping");
    } else {
      const sleeping = session.query("job");
      assert.equal(sleeping.status, "sleeping");
      const saved = session.calls("job");
      assert.equal(saved[0].result.details.value, sleeping.checkpoint);
      const deadline = session.nextWake();
      assert.equal(deadline.taskId, "job");
      assert.equal(deadline.sleepId, sleeping.sleep.sleepId);
      assert.equal(deadline.remainingMs, 0);
      assert.equal((await session.wake("job", "alarm-1", deadline.sleepId)).status, "accepted");
      assert.equal((await session.resume("job")).status, "completed");
      assert.deepEqual(session.calls("job"), saved);
    }
    process.stdout.write(
      JSON.stringify({ pid: process.pid, task: session.query("job"), calls: session.calls("job") }),
    );
  } finally {
    await session.close();
  }
} else {
  const workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-task-restart-"));
  try {
    const run = (part) =>
      JSON.parse(
        execFileSync(process.execPath, [fileURLToPath(import.meta.url), part, workspace], {
          encoding: "utf8",
          timeout: 30_000,
        }),
      );
    // 两次独立 Node 启动，A 已保存等待后退出，B 从原事实恢复。
    const first = run("a");
    const second = run("b");
    assert.notEqual(first.pid, second.pid);
    assert.notEqual(first.pid, process.pid);
    assert.notEqual(second.pid, process.pid);
    assert.equal(first.task.checkpoint, 1);
    assert.equal(second.task.checkpoint, 2);
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].key, "record");
    assert.equal(first.calls[0].status, "completed");
    assert.deepEqual(second.calls, first.calls);
    const executions = (await readFile(path.join(workspace, "canary.txt"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(executions.length, 1);
    assert.ok(executions[0].startsWith(`${first.pid}:`));
    console.log(
      JSON.stringify({
        firstPid: first.pid,
        secondPid: second.pid,
        runId: first.calls[0].runId,
        key: "record",
        executions: 1,
        checkpoint: second.task.checkpoint,
      }),
    );
    console.log("Task process restart, wake and committed-result reuse OK");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

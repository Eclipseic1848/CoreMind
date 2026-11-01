import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TaskSession } from "../../packages/coremind-runtime/dist/index.js";

const [workspace, mode] = process.argv.slice(2);
const marker = path.join(workspace, "phases.txt");
const migrating = mode === "migrate-crash" || mode === "migrate-resume";
const definition = {
  type: "example",
  version: migrating ? 2 : 1,
  initialPhase: "a",
  checkpointSchema: { type: "integer" },
  phases: {
    a({ task }) {
      if (task.version === 2 && !existsSync(path.join(workspace, "exited"))) {
        writeFileSync(path.join(workspace, "exited"), "yes", "utf8");
        process.exit(23);
      }
      appendFileSync(marker, "A\n", "utf8");
      return { phase: "b", checkpoint: task.checkpoint + 1 };
    },
    b({ task }) {
      appendFileSync(marker, "B\n", "utf8");
      return { phase: "b", checkpoint: task.checkpoint + 1, done: true };
    },
  },
  ...(migrating
    ? {
        migrate(previous) {
          appendFileSync(marker, "M\n", "utf8");
          return { phase: "a", checkpoint: previous.checkpoint + 10 };
        },
      }
    : {}),
};

const session = await TaskSession.open({
  workspace,
  sessionId: "process",
  definitions: [definition],
});
if (mode === "start" || mode === "commit-exit")
  await session.start({ taskId: "job", type: "example", checkpoint: 0 });
if (mode !== "start") await session.resume("job");
if (mode === "commit-exit") process.exit(23);
process.stdout.write(
  JSON.stringify({
    task: session.query("job"),
    calls: existsSync(marker) ? readFileSync(marker, "utf8") : "",
  }),
);
await session.close();

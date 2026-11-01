import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { TaskSession } from "../../packages/coremind-runtime/dist/index.js";

const [workspace, mode, clock] = process.argv.slice(2);
const marker = path.join(workspace, "phases.txt");
const session = await TaskSession.open({
  workspace,
  sessionId: "sleep-process",
  clock: () => Number(clock),
  definitions: [
    {
      type: "sleeper",
      version: 1,
      initialPhase: "a",
      checkpointSchema: { type: "integer" },
      phases: {
        a() {
          appendFileSync(marker, "A\n", "utf8");
          return { phase: "b", checkpoint: 1, sleepUntil: 1000 };
        },
        b() {
          appendFileSync(marker, "B\n", "utf8");
          return { phase: "b", checkpoint: 2, done: true };
        },
      },
    },
  ],
});
if (mode === "sleep-exit") {
  await session.start({ taskId: "job", type: "sleeper", checkpoint: 0 });
  await session.resume("job");
  process.exit(23);
}
if (mode === "wake-exit") {
  await session.wake("job", "alarm", session.query("job").sleep.sleepId);
  process.exit(23);
}
if (mode === "resume") await session.resume("job");
process.stdout.write(
  JSON.stringify({
    task: session.query("job"),
    next: session.nextWake(),
    calls: existsSync(marker) ? readFileSync(marker, "utf8") : "",
  }),
);
await session.close();

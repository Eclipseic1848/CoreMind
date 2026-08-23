import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeEntry = path.join(
  scriptDirectory,
  "..",
  "packages",
  "coremind-runtime",
  "dist",
  "index.js",
);
const [directory, runId, mode] = process.argv.slice(2);
if (!directory || !runId) throw new Error("需要 Store 目录与 runId");

const { FileRunStore, RunStateJournal } = await import(pathToFileURL(runtimeEntry).href);
const store = new FileRunStore(
  directory,
  mode === "lock-crash"
    ? {
        beforeBarrier: () => process.exit(87),
      }
    : undefined,
);
const journal = new RunStateJournal(runId, store);
await journal.start({ probe: "process-crash" });
await journal.appendFact(
  "event",
  { type: "probe_fact", value: "critical-visible-after-exit" },
  { durability: "critical", eventId: "crash-probe-critical-fact" },
);

// 不执行 Runtime 的正常收尾，模拟精确 Fact commit ack 后进程立即退出。
process.exit(86);

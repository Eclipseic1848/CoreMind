import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerEntry = path.join(
  scriptDirectory,
  "..",
  "packages",
  "coremind-worker",
  "dist",
  "index.js",
);
const runtimeEntry = path.join(
  scriptDirectory,
  "..",
  "packages",
  "coremind-runtime",
  "dist",
  "index.js",
);
const [configDir, effectMarker, runId, input] = process.argv.slice(2);
if (!configDir || !effectMarker || !runId || !input) {
  throw new Error("需要 configDir、effectMarker、runId 与 input");
}

const [{ ProtocolHost }, { RunStateJournal }] = await Promise.all([
  import(pathToFileURL(workerEntry).href),
  import(pathToFileURL(runtimeEntry).href),
]);

const host = new ProtocolHost({
  send: () => {},
  runtimeFactory: async (options) => ({
    run: async () => {
      const journal = new RunStateJournal(options.runId, options.runStore);
      await journal.start({ protocolStart: options.protocolStart });
      await appendFile(effectMarker, "provider\ntool\n", "utf8");
      process.stdout.write("READY\n");
      return new Promise(() => {});
    },
  }),
});

await host.handle({
  jsonrpc: "2.0",
  id: "initialize-crash-probe",
  method: "initialize",
  params: {
    protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
    config: { schemaVersion: 2, name: "crash-probe", agents: { main: {} } },
    configDir,
    cwd: configDir,
  },
});
await host.handle({
  jsonrpc: "2.0",
  protocolVersion: "2.0",
  id: "run-crash-probe",
  method: "run",
  params: { runId, input },
});

await new Promise(() => {});

import { appendFile } from "node:fs/promises";
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
const [storeDirectory, effectMarker] = process.argv.slice(2);
if (!storeDirectory || !effectMarker) throw new Error("需要 storeDirectory 与 effectMarker");

const { ChildRunCoordinator, FileRunStore, RunStateJournal } = await import(
  pathToFileURL(runtimeEntry).href
);
const store = new FileRunStore(storeDirectory);
const journal = new RunStateJournal("run-crash-parent", store);
await journal.start({ configFingerprint: "child-crash-probe" });
const model = {
  providerId: "test-provider",
  model: "test-model",
  providerConfigFingerprint: "sha256:test-provider-config",
  agentPromptFingerprint: "sha256:test-agent-prompt",
  agentDelegationFingerprint: "sha256:test-agent-delegation",
};
const policy = {
  depth: 0,
  budget: {
    tokens: 100,
    toolCalls: 10,
    costUsd: 10,
    wallTimeMs: 10_000,
    steps: 10,
    descendants: 4,
  },
  permissions: {
    mode: "ask",
    workspaceOnly: true,
    network: "deny",
    tools: ["read"],
    paths: ["."],
    credentials: [],
  },
  environment: { networkEgress: "denied" },
  model,
  delegationModelRoutes: {
    __default__: { worker: model },
  },
  workspace: { canonicalRoot: "C:/test-workspace", lease: "shared_canonical" },
  protectedContextReferences: [],
};
const request = {
  delegationId: "delegation-crash",
  parentTurnId: "turn-test",
  parentStepId: "step-test",
  agentName: "worker",
  task: "执行确定性测试子任务",
  model: policy.model,
  workspace: policy.workspace,
  lifecyclePolicy: {
    join: "structured",
    cancel: "propagate_parent",
    orphan: "audit_pause",
    detach: "forbidden",
  },
  context: { workingSetFingerprint: "sha256:delegation-crash", references: [] },
  allocation: { tokens: 10, toolCalls: 1, costUsd: 1, wallTimeMs: 1_000, steps: 1, descendants: 0 },
  permissions: policy.permissions,
  environment: policy.environment,
};
const coordinator = await ChildRunCoordinator.open({
  parentRunId: "run-crash-parent",
  parentJournal: journal,
  runStore: store,
  parentPolicy: policy,
  adapter: {
    execute: async () => {
      await appendFile(effectMarker, "child-effect\n", "utf8");
      process.stdout.write("READY\n");
      return new Promise(() => {});
    },
  },
  createChildRunId: () => "run-crash-child",
});
await coordinator.delegate(request);
await new Promise(() => {});

import type { CoreMindEvent } from "../../packages/coremind-runtime/src/events.js";
import type { FileRunStore } from "../../packages/coremind-runtime/src/run-state.js";

/** 仅诊断首格安装有界观测；回调结束即恢复宿主原值。 */
export async function observeMcpStartup<T>(action: () => Promise<T>): Promise<T> {
  const key = Symbol.for("coremind.mcpStartup.capture");
  const previous = Reflect.get(globalThis, key);
  const allowed = new Set([
    "bounded_timeout",
    "cleanup_done",
    "cleanup_record_initialized",
    "cleanup_record_not_initialized",
    "cleanup_record_not_started",
    "cleanup_record_started",
    "client_sdk_import_begin",
    "client_sdk_import_done",
    "connect_effect_commit_begin",
    "connect_effect_commit_done",
    "connect_gate_enter",
    "connect_gate_release",
    "connect_observed_commit_begin",
    "connect_observed_commit_done",
    "domain_resolve_begin",
    "domain_resolve_done",
    "fixture_abort",
    "fixture_enter",
    "fixture_ready",
    "helper_spawn_event",
    "helper_spawned",
    "host_connect_begin",
    "host_connect_fulfilled",
    "initialize_reply",
    "initialize_send",
    "job_assets_verified",
    "job_launch_begin",
    "job_launch_done",
    "job_prepare_begin",
    "job_ready_done",
    "job_ready_wait",
    "list_gate_enter",
    "observed",
    "owner_job_ready",
    "owner_listen_ready",
    "owner_socket_connected",
    "process_probe_abort",
    "process_probe_bad_cancel",
    "process_probe_begin",
    "process_probe_descendant_survived",
    "process_probe_descendants_gone",
    "process_probe_finally",
    "process_probe_joined",
    "process_probe_no_pid",
    "process_probe_pid_seen",
    "run_settled",
    "runtime_client_connect_begin",
    "runtime_client_connect_fulfilled",
    "runtime_env_done",
    "runtime_executing",
    "runtime_identity_done",
    "runtime_invoke_begin",
    "sdk_client_connect_begin",
    "sdk_client_connect_fulfilled",
    "service_listen_ready",
    "service_ready",
    "service_socket_connected",
    "transport_domain_begin",
    "transport_sdk_begin",
    "transport_sdk_done",
    "wait_business_timeout",
    "wait_connect_approval_timeout",
    "wait_connect_result_timeout",
    "wait_connect_timeout",
    "wait_list_timeout",
  ]);
  const began = performance.now();
  const entries: Array<{ stage: string; elapsedMs: number }> = [];
  const seen = new Set<string>();
  const startupTrace = Object.assign(
    (stage: string) => {
      if (!allowed.has(stage) || seen.has(stage) || entries.length >= 64) return;
      seen.add(stage);
      entries.push({ stage, elapsedMs: Number((performance.now() - began).toFixed(3)) });
    },
    {
      snapshot: () => entries.map((entry) => ({ ...entry })),
      initializeIds: new WeakMap<object, unknown>(),
      run: <R>(callback: () => R): R => callback(),
    },
  );
  Reflect.set(globalThis, key, () => startupTrace);
  let passed = false;
  try {
    const result = await action();
    passed = true;
    return result;
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, previous);
    try {
      console.log("COREMIND_MCP_STARTUP_TIMING " + JSON.stringify({ passed, entries }));
    } catch {
      // 诊断输出失败不得改变原用例结果。
    }
  }
}

export function observeMcpCommits(store: FileRunStore, getStage: () => number): void {
  const startupTrace = Reflect.get(globalThis, Symbol.for("coremind.mcpStartup.capture"))?.();
  const originalCommit = store.commit.bind(store);
  store.commit = async (...args: Parameters<typeof store.commit>) => {
    const record = args[0];
    const event =
      record.kind === "event" ? (record.payload as { event: CoreMindEvent }).event : undefined;
    const observedStage =
      getStage() !== 1
        ? undefined
        : event?.type === "effect_receipt" && event.status === "committed"
          ? "connect_effect_commit"
          : event?.type === "tool_lifecycle" && event.resolution.phase === "observed"
            ? "connect_observed_commit"
            : undefined;
    if (observedStage) startupTrace?.(`${observedStage}_begin`);
    const acknowledgement = await originalCommit(...args);
    if (observedStage) startupTrace?.(`${observedStage}_done`);
    return acknowledgement;
  };
}

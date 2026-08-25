import type { LocalObservabilityProjection } from "coremind-ai";

/** CLI 与 TUI 共用的显性本地观测状态。 */
export function formatObservabilityStatus(observability: LocalObservabilityProjection): string {
  const delivery = observability.telemetry;
  const toolStates = observability.tools.map((tool) => {
    const phases = tool.phases
      .map(
        (phase) => `${phase.phase}:${phase.status}${"reason" in phase ? `(${phase.reason})` : ""}`,
      )
      .join(">");
    const result = Object.entries(tool.result)
      .map(([axis, value]) => `${axis}=${value}`)
      .join(",");
    return `${tool.tool}#${tool.callId}@${tool.agent}${tool.stepId ? `/${tool.stepId}` : ""} current=${tool.currentPhase} terminal=${tool.terminal} phases=[${phases}] result=[${result}]`;
  });
  const errors = observability.errors.map(
    (error) => `#${error.sequence}:${error.fatal ? "fatal" : "recoverable"}:${error.message}`,
  );
  const scopes = delivery.authorizedScopes.map((scope) => {
    const fields = scope.allowedFields.length === 0 ? "无" : scope.allowedFields.join(",");
    return `${scope.consentId}@${scope.runId}:${scope.kind}:${scope.targetOrigin}:${scope.contentLevel}:fields=${fields}${scope.throughSequence === undefined ? "" : `:through=${scope.throughSequence}`}`;
  });
  return [
    `本地观测 ${observability.localEnabled ? "开启" : "关闭"}`,
    `Run status=${observability.run.status} resumable=${observability.run.resumable} duration=${observability.run.durationMs === undefined ? "unknown" : `${observability.run.durationMs}ms`}${observability.run.operationState ? ` operation=${observability.run.operationState}` : ""}`,
    `Turn started=${observability.turns.started} completed=${observability.turns.completed} active=${observability.turns.active}`,
    `Call started=${observability.calls.started} completed=${observability.calls.completed} failed=${observability.calls.failed} active=${observability.calls.active} duration=${observability.calls.durationMs}ms`,
    `Recovery ${observability.recovery.resumable ? "可恢复" : "不可恢复"}${observability.recovery.operationState ? `/${observability.recovery.operationState}` : ""}`,
    `Tool ${toolStates.length === 0 ? "无" : toolStates.join(" | ")}`,
    `Error ${errors.length === 0 ? "无" : errors.join(" | ")}`,
    `Context budget ${observability.context.budgets} / compaction ${observability.context.compactions} / failure ${observability.context.failures}`,
    `Artifact ${observability.artifacts.stored}/${observability.artifacts.blocked}`,
    `Shared pending ${observability.sharedState.pendingControls}`,
    `Telemetry ${delivery.mode}`,
    delivery.contentLevel,
    `endpoint ${delivery.endpointOrigin ?? "未配置"}`,
    `source ${delivery.source}`,
    `fields ${delivery.allowedFields.length === 0 ? "无" : delivery.allowedFields.join(",")}`,
    `consent ${scopes.length === 0 ? "无" : scopes.join(" | ")}`,
    `Exporter ${delivery.exporterLoaded ? "已加载" : "未加载"}`,
    `queue ${delivery.queued} / handed-off ${delivery.handedOff} / failed ${delivery.failed} / dropped ${delivery.dropped} / duplicates ${delivery.duplicates} / shutdown-timeout ${delivery.shutdownTimedOut}${delivery.lastFailure ? ` / last-failure ${delivery.lastFailure}` : ""}`,
    "handed-off 仅表示移交，不代表 delivered",
  ].join(" · ");
}

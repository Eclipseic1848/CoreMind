import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** 保留真实文件副作用与完整父子链校验，供认证入口和离线回归共用。 */
export async function checkCertificationChildRun(context) {
  const { result, markerFile, marker } = context;
  try {
    context.markerStatus = (await readFile(markerFile, "utf8")) === marker ? "matched" : "mismatch";
  } catch (error) {
    context.markerStatus = error?.code === "ENOENT" ? "missing" : "unavailable";
    if (context.markerStatus !== "missing") throw error;
  }
  const facts = certificationChildFacts(context);
  if (
    facts.nodeCount !== 1 ||
    !facts.joined ||
    facts.childOutcome !== "succeeded" ||
    facts.activeDescendants !== 0 ||
    !facts.quiescent ||
    facts.parentProviderCalls < 1 ||
    facts.childProviderCalls < 1 ||
    !facts.delegationToolCalled ||
    !facts.delegationToolCompleted ||
    !facts.childToolCalled ||
    !facts.childToolCompleted ||
    facts.markerStatus !== "matched" ||
    !facts.structuredResultPresent
  ) {
    throw new Error("真实父子 Agent 产品链不完整");
  }
  return {
    passed: true,
    parentProviderCalls: facts.parentProviderCalls,
    delegationToolCalled: facts.delegationToolCalled,
    childProviderCalls: facts.childProviderCalls,
    childTool: "write",
    childToolCompleted: facts.childToolCompleted,
    childOutcome: facts.childOutcome,
    joined: facts.joined,
    quiescent: facts.quiescent,
    structuredResultSha256: createHash("sha256")
      .update(JSON.stringify(result.childRuns.nodes[0].result))
      .digest("hex"),
  };
}

/** 只取固定布尔、计数和枚举，不序列化模型内容、工具参数或异常。 */
export function certificationChildFacts({
  result,
  events,
  markerStatus,
  approvalsAllowed,
  approvalsDenied,
}) {
  const node = result?.childRuns?.nodes[0];
  const countEvents = (type, agent) =>
    events.filter((event) => event.type === type && event.agent === agent).length;
  const hasToolEvent = (type, agent, tool) =>
    events.some(
      (event) =>
        event.type === type &&
        event.agent === agent &&
        event.tool === tool &&
        (type !== "tool_result" || event.isError === false),
    );
  return {
    parentOutcome: fixedValue(result?.outcome?.status, [
      "succeeded",
      "failed",
      "paused",
      "aborted",
    ]),
    childOutcome: fixedValue(node?.outcome?.status, ["succeeded", "failed", "paused", "aborted"]),
    nodeCount: result?.childRuns?.nodes.length ?? null,
    joined: node?.status === "joined",
    activeDescendants: nonnegative(result?.childRuns?.activeDescendants, true),
    quiescent: result?.childRuns?.quiescent === true,
    parentProviderCalls: countEvents("provider_request", "parent"),
    childProviderCalls: countEvents("provider_request", "worker"),
    delegationToolCalled: hasToolEvent("tool_call", "parent", "delegate"),
    delegationToolCompleted: hasToolEvent("tool_result", "parent", "delegate"),
    childToolCalled: hasToolEvent("tool_call", "worker", "write"),
    childToolCompleted: hasToolEvent("tool_result", "worker", "write"),
    toolErrors: events.filter((event) => event.type === "tool_result" && event.isError === true)
      .length,
    approvalsAllowed: nonnegative(approvalsAllowed, true),
    approvalsDenied: nonnegative(approvalsDenied, true),
    structuredResultPresent: Boolean(node?.result),
    markerStatus: fixedValue(markerStatus, [
      "not_checked",
      "matched",
      "mismatch",
      "missing",
      "unavailable",
    ]),
  };
}

/** 失败观察永远不是完整账单，也不能作为成功资格或再次调用的剩余额度。 */
export function createCertificationFailure({
  version,
  commit,
  runtimeArtifactSha256,
  candidateArtifactSha256,
  runtimeDigest,
  artifactManifestDigest,
  stage,
  approval,
  events,
  durationMs,
  child,
}) {
  const turns = events.filter((event) => event.type === "turn_end");
  const observed = (key, integer = false) => {
    const values = turns
      .map((event) => nonnegative(event[key], integer))
      .filter((value) => value !== null);
    return values.length
      ? nonnegative(
          values.reduce((sum, value) => sum + value, 0),
          integer,
        )
      : null;
  };
  const sha = (value, prefix = "") =>
    new RegExp(`^${prefix}[0-9a-f]{64}$`, "u").test(value ?? "") ? value : null;
  const inputTokensObserved = observed("inputTokens", true);
  const outputTokensObserved = observed("outputTokens", true);
  const costUsdObserved = observed("costUsd");
  return {
    schemaVersion: 1,
    kind: "provider-certification-failure",
    status: "failed",
    evidenceLevel: "diagnostic-only",
    version:
      typeof version === "string" &&
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version) &&
      version.length < 64
        ? version
        : null,
    commit: /^[0-9a-f]{40}$/u.test(commit ?? "") ? commit : null,
    runtimeArtifactSha256: sha(runtimeArtifactSha256),
    candidateArtifactSha256: sha(candidateArtifactSha256),
    runtimeDigest: sha(runtimeDigest, "sha256:"),
    artifactManifestDigest: sha(artifactManifestDigest, "sha256:"),
    stage: fixedValue(stage, [
      "streaming",
      "tool-call",
      "child-create",
      "child-run",
      "child-validate",
      "child-cancel",
      "multi-turn",
      "abort",
      "long-context",
      "auth-error",
      "evidence",
    ]),
    approval: {
      maxCostUsd: nonnegative(approval?.maxCostUsd),
      maxDurationMs: nonnegative(approval?.maxDurationMs, true),
      maxRetries: nonnegative(approval?.maxRetries, true),
    },
    usage: {
      completeness: [inputTokensObserved, outputTokensObserved, costUsdObserved].some(
        (value) => value !== null,
      )
        ? "partial"
        : "unknown",
      providerCallsObserved: events.filter((event) => event.type === "provider_request").length,
      turnsObserved: turns.length,
      completeUsageTurns: turns.filter(
        (event) =>
          nonnegative(event.inputTokens, true) !== null &&
          nonnegative(event.outputTokens, true) !== null &&
          nonnegative(event.costUsd) !== null,
      ).length,
      inputTokensObserved,
      outputTokensObserved,
      costUsdObserved,
      durationMs: nonnegative(durationMs, true),
      retriesObserved: events.filter(
        (event) => event.type === "retry" && event.scope === "provider",
      ).length,
    },
    // 此现场只属于父子成功链；后续场景失败不能引用先前成功 Run 的事实。
    child:
      child && ["child-create", "child-run", "child-validate"].includes(stage)
        ? certificationChildFacts(child)
        : null,
  };
}

/** 两种输出彼此隔离；普通观测或输出失败不能替换原失败或中断 finally 清理。 */
export async function recordCertificationFailure(snapshot, { writeLog, writeArtifact }) {
  let json;
  try {
    json = `${JSON.stringify(createCertificationFailure(snapshot))}\n`;
    if (Buffer.byteLength(json, "utf8") > 4096) return;
  } catch {
    return;
  }
  try {
    await writeLog(`COREMIND_CERTIFICATION_FAILURE ${json.trimEnd()}`);
  } catch {
    /* 保留原失败。 */
  }
  try {
    await writeArtifact(json);
  } catch {
    /* 保留原失败。 */
  }
}

function fixedValue(value, allowed) {
  return allowed.includes(value) ? value : "unknown";
}

function nonnegative(value, integer = false) {
  return Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value))
    ? value
    : null;
}

// 为父模型请求和汇总保留预算，不能把父 Run 的全部额度交给 Child。
export function certificationChildBudget({ wallTimeMs, costUsd }) {
  return { wallTimeMs: Math.floor(wallTimeMs / 2), costUsd: costUsd / 2 };
}

export function assertCertificationSucceeded(result, label, secrets = []) {
  if (result.outcome.status === "succeeded") return;
  const error = result.outcome.error;
  const details = [result.outcome.finishReason, error?.code, error?.message]
    .concat(
      (result.childRuns?.nodes ?? [])
        .filter((node) => node.outcome && node.outcome.status !== "succeeded")
        .map(
          (node) =>
            `Child ${node.agentName}: ${node.outcome.finishReason} / ${node.outcome.error?.message ?? ""}`,
        ),
    )
    .filter(Boolean)
    .join(" / ");
  const redacted = secrets
    .filter(Boolean)
    .reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), details);
  throw new Error(`${label}失败：${redacted}`);
}

/** 校验同次 Candidate 产生的 Runtime 包，不接受别的提交或手工替换摘要。 */
export function inspectCandidateManifest(raw, expected) {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error("候选制品清单不是有效 JSON");
  }
  if (manifest?.version !== expected.version || manifest?.commit !== expected.commit) {
    throw new Error("候选制品清单身份与批准值不一致");
  }
  const runtime = manifest.artifacts?.find(
    (artifact) => artifact?.kind === "npm" && artifact?.name === "coremind-runtime",
  );
  if (runtime?.version !== expected.version || !/^[0-9a-f]{64}$/u.test(runtime?.sha256 ?? "")) {
    throw new Error("候选制品清单缺少 Runtime Artifact");
  }
  if (runtime.sha256 !== expected.runtimeArtifactSha256) {
    throw new Error("候选 Runtime Artifact 与批准值不一致");
  }
  if (
    typeof runtime.path !== "string" ||
    runtime.path.length === 0 ||
    /^(?:[A-Za-z]:)?[\\/]/u.test(runtime.path) ||
    runtime.path.split(/[\\/]/u).includes("..")
  ) {
    throw new Error("候选 Runtime Artifact 路径无效");
  }
  return {
    candidateArtifactPath: runtime.path,
    candidateArtifactSha256: runtime.sha256,
    artifactManifestDigest: `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`,
  };
}

export function verifyCandidateArtifact(content, expectedSha256) {
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("候选 Runtime Artifact 实际摘要与清单不一致");
  }
}

/** 在读取凭据或调用 Provider 前固定本次人工批准与候选身份。 */
export function validateCertificationApproval(approval, actual) {
  for (const key of ["provider", "model", "credentialEnv", "maxCostUsd", "maxDurationMinutes"]) {
    if (String(approval?.[key] ?? "").trim().length === 0) {
      throw new Error(`认证批准边界不完整：${key}`);
    }
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(approval.credentialEnv)) {
    throw new Error("认证凭据环境变量名无效");
  }
  const maxCostUsd = Number(approval.maxCostUsd);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new Error("认证费用上限必须是大于 0 的有限数值");
  }
  const maxDurationMinutes = Number(approval.maxDurationMinutes);
  if (!Number.isInteger(maxDurationMinutes) || maxDurationMinutes < 1 || maxDurationMinutes > 60) {
    throw new Error("认证最长运行时间必须是 1 到 60 分钟的整数");
  }
  if (approval.expectedVersion !== actual?.version) {
    throw new Error("认证候选版本与批准值不一致");
  }
  if (!/^[0-9a-f]{40}$/u.test(approval.expectedCommit ?? "")) {
    throw new Error("认证批准值缺少完整 Git commit");
  }
  if (approval.expectedCommit !== actual?.commit) {
    throw new Error("认证候选提交与批准值不一致");
  }
  if (!/^[0-9a-f]{64}$/u.test(approval.expectedRuntimeArtifactSha256 ?? "")) {
    throw new Error("认证批准值缺少 Runtime Artifact SHA-256");
  }
  if (approval.expectedRuntimeArtifactSha256 !== actual?.runtimeArtifactSha256) {
    throw new Error("认证 Runtime Artifact 与批准值不一致");
  }
  return {
    provider: approval.provider.trim(),
    model: approval.model.trim(),
    credentialEnv: approval.credentialEnv,
    maxCostUsd,
    maxDurationMs: maxDurationMinutes * 60_000,
    maxRetries: 0,
  };
}

const REQUIRED_DETAIL_KEYS = [
  "streaming",
  "toolCall",
  "structuredResult",
  "multiTurn",
  "abort",
  "error",
  "longContext",
  "childRun",
  "childRunCancel",
];

/** 只在基础检查与父子产品链完整通过后生成可提交的认证证据。 */
export function createCertificationEvidence({
  provider,
  model,
  testedAt,
  platform,
  node,
  version,
  commit,
  runtimeArtifactSha256,
  candidateArtifactSha256,
  runtimeDigest,
  artifactManifestDigest,
  ref,
  approval,
  usage,
  details,
}) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("Provider 认证证据缺少 CoreMind 版本");
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
    throw new Error("Provider 认证证据缺少完整 Git commit");
  }
  if (!/^[0-9a-f]{64}$/.test(runtimeArtifactSha256 ?? "")) {
    throw new Error("Provider 认证证据缺少 Runtime Artifact SHA-256");
  }
  for (const key of REQUIRED_DETAIL_KEYS) {
    if (details?.[key]?.passed !== true) {
      throw new Error(`Provider 认证检查未通过：${key}`);
    }
  }
  if (!Number.isInteger(details.multiTurn.turns) || details.multiTurn.turns < 3) {
    throw new Error("Provider 多轮会话认证至少需要三轮");
  }
  if (
    details.childRun.parentProviderCalls < 1 ||
    details.childRun.childProviderCalls < 1 ||
    details.childRun.delegationToolCalled !== true ||
    details.childRun.childTool !== "write" ||
    details.childRun.childToolCompleted !== true ||
    details.childRun.childOutcome !== "succeeded" ||
    details.childRun.joined !== true ||
    details.childRun.quiescent !== true ||
    !/^[0-9a-f]{64}$/u.test(details.childRun.structuredResultSha256 ?? "")
  ) {
    throw new Error("Provider 父子产品链证据不完整");
  }
  if (
    details.childRunCancel.abortTriggeredAt !== "child_text_delta" ||
    details.childRunCancel.childOutcome !== "aborted" ||
    details.childRunCancel.activeDescendants !== 0 ||
    details.childRunCancel.executionConverged !== true ||
    !Number.isFinite(details.childRunCancel.convergenceMs) ||
    details.childRunCancel.convergenceMs < 0 ||
    details.childRunCancel.convergenceMs > details.childRunCancel.maxConvergenceMs
  ) {
    throw new Error("Provider 父子取消收敛证据不完整");
  }
  if (!/^[0-9a-f]{64}$/u.test(candidateArtifactSha256 ?? "")) {
    throw new Error("Provider 认证证据缺少候选 Runtime Artifact SHA-256");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(runtimeDigest ?? "")) {
    throw new Error("Provider 认证证据缺少 Runtime 摘要");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(artifactManifestDigest ?? "")) {
    throw new Error("Provider 认证证据缺少候选制品清单摘要");
  }
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new Error("Provider 认证证据缺少可审计引用");
  }
  if (
    approval?.provider !== provider ||
    approval?.model !== model ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(approval?.credentialEnv ?? "") ||
    !Number.isFinite(approval?.maxCostUsd) ||
    approval.maxCostUsd <= 0 ||
    !Number.isInteger(approval?.maxDurationMs) ||
    approval.maxDurationMs <= 0
  ) {
    throw new Error("Provider 认证批准边界无效");
  }
  if (approval.maxRetries !== 0 || usage?.retries !== 0) {
    throw new Error("Provider 认证禁止自动重试");
  }
  if (
    !Number.isInteger(usage?.providerCalls) ||
    usage.providerCalls < 1 ||
    !Number.isInteger(usage?.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isInteger(usage?.outputTokens) ||
    usage.outputTokens < 0 ||
    !Number.isInteger(usage?.totalTokens) ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    !Number.isFinite(usage?.costUsd) ||
    usage.costUsd < 0 ||
    !Number.isInteger(usage?.durationMs) ||
    usage.durationMs < 0
  ) {
    throw new Error("Provider 认证脱敏用量无效");
  }
  if (usage.costUsd > approval.maxCostUsd || usage.durationMs > approval.maxDurationMs) {
    throw new Error("Provider 认证用量超过批准边界");
  }

  return {
    schemaVersion: 2,
    checkId: "P0-20",
    status: "passed",
    evidenceLevel: "live-provider",
    provider,
    model,
    version,
    commit,
    runtimeArtifactSha256,
    candidateArtifactSha256,
    runtimeDigest,
    artifactManifestDigest,
    ref,
    testedAt,
    generatedAt: testedAt,
    platform,
    node,
    checks: [
      "streaming",
      "tool-call",
      "structured-result",
      "multi-turn",
      "abort",
      "error",
      "long-context",
      "parent-model-call",
      "delegation-tool",
      "child-model-call",
      "child-tool-call",
      "cancel-convergence",
    ],
    approval,
    usage,
    details,
    dataPolicy: "synthetic-only",
    secretsRecorded: false,
  };
}

/** 以 Provider 和版本为唯一键更新认证台账，避免同一候选出现互相矛盾的记录。 */
export function upsertCertificationRecord(ledger, evidence, evidenceUrl) {
  if (ledger?.schemaVersion !== 2 || !Array.isArray(ledger.certifications)) {
    throw new Error("Provider 认证台账格式无效");
  }
  const record = {
    id: evidence.provider,
    model: evidence.model,
    version: evidence.version,
    commit: evidence.commit,
    runtimeArtifactSha256: evidence.runtimeArtifactSha256,
    candidateArtifactSha256: evidence.candidateArtifactSha256,
    runtimeDigest: evidence.runtimeDigest,
    artifactManifestDigest: evidence.artifactManifestDigest,
    testedAt: evidence.testedAt,
    checks: [...evidence.checks],
    evidence: evidenceUrl,
  };
  return {
    ...ledger,
    updatedAt: evidence.testedAt.slice(0, 10),
    certifications: [
      ...ledger.certifications.filter(
        (item) => !(item.id === record.id && item.version === record.version),
      ),
      record,
    ],
  };
}

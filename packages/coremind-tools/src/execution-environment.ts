export type EnvironmentNetworkEgress = "unrestricted" | "adapter_scoped" | "allowlist" | "deny_all";

export type EnvironmentPathAccess = "unrestricted" | "workspace" | "none";
export type EnvironmentCredentialIsolation = "none" | "environment" | "environment_and_files";
export type EnvironmentProcessControl = "none" | "process" | "process_tree";
export type EnvironmentDurability = "process_memory" | "critical";

export interface ExecutionEnvironmentTerminationCapabilities {
  kill: EnvironmentProcessControl;
  timeout: boolean;
  pty: boolean;
}

export interface ExecutionEnvironmentIdentity {
  platform: NodeJS.Platform;
  adapter: string;
  adapterVersion: string;
}

export interface ExecutionEnvironmentCapabilities {
  isolation: "trusted_host" | "linux_sandbox" | "fake";
  readAccess: EnvironmentPathAccess;
  writeAccess: EnvironmentPathAccess;
  outsideWorkspaceAccess: "allowed" | "blocked";
  networkEgress: EnvironmentNetworkEgress;
  credentialIsolation: EnvironmentCredentialIsolation;
  processControl: EnvironmentProcessControl;
  termination: ExecutionEnvironmentTerminationCapabilities;
  durability: EnvironmentDurability;
  identity: ExecutionEnvironmentIdentity;
}

export type ExecutionEnvironmentCapabilityInput = Partial<
  Omit<ExecutionEnvironmentCapabilities, "termination" | "identity">
> & {
  termination?: Partial<ExecutionEnvironmentTerminationCapabilities>;
  identity?: Partial<ExecutionEnvironmentIdentity>;
};

export interface ExecutionEnvironmentProbe {
  status: "verified" | "failed";
  capabilities: ExecutionEnvironmentCapabilities;
  evidence: readonly string[];
}

export interface ExecutionEnvironment {
  readonly id: string;
  readonly claimedCapabilities: ExecutionEnvironmentCapabilities;
  probe(): Promise<ExecutionEnvironmentProbe>;
  beginActivity(input: ExecutionEnvironmentActivityInput): ExecutionEnvironmentActivity;
  terminate(reason: string): Promise<void>;
  isQuiescent(): boolean;
}

export interface ExecutionEnvironmentActivityInput {
  id: string;
  kind: "process" | "network" | "temporary_resource";
}

export interface ExecutionEnvironmentActivity {
  readonly signal: AbortSignal;
  settle(): void;
}

export interface ExecutionEnvironmentRequirement {
  isolation?: "sandbox";
  readAccess?: Exclude<EnvironmentPathAccess, "unrestricted">;
  writeAccess?: Exclude<EnvironmentPathAccess, "unrestricted">;
  outsideWorkspaceAccess?: "blocked";
  networkEgress?: "controlled" | "denied";
  credentialIsolation?: Exclude<EnvironmentCredentialIsolation, "none">;
  processControl?: Exclude<EnvironmentProcessControl, "none">;
  termination?: Partial<ExecutionEnvironmentTerminationCapabilities>;
  durability?: "critical";
}

export type ExecutionEnvironmentErrorCode =
  | "environment_probe_failed"
  | "environment_capability_mismatch"
  | "environment_requirement_unsatisfied"
  | "environment_activity_conflict"
  | "environment_terminate_failed";

export class ExecutionEnvironmentError extends Error {
  constructor(
    readonly code: ExecutionEnvironmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionEnvironmentError";
  }
}

export interface ResolvedExecutionEnvironment {
  environmentId: string;
  capabilities: ExecutionEnvironmentCapabilities;
  evidence: readonly string[];
}

/** 只接受探针证明的能力；声明强于观测值时直接拒绝，不能静默降级。 */
export async function resolveExecutionEnvironment(
  environment: ExecutionEnvironment,
  requirement: ExecutionEnvironmentRequirement,
): Promise<ResolvedExecutionEnvironment> {
  const probe = await environment.probe();
  if (probe.status !== "verified") {
    throw new ExecutionEnvironmentError(
      "environment_probe_failed",
      `执行环境 ${environment.id} 的能力探针失败`,
    );
  }
  const mismatch = capabilityMismatch(environment.claimedCapabilities, probe.capabilities);
  if (mismatch) {
    throw new ExecutionEnvironmentError(
      "environment_capability_mismatch",
      `执行环境 ${environment.id} 声明的 ${mismatch} 强于实际探针结果`,
    );
  }
  const unsatisfied = unsatisfiedRequirement(probe.capabilities, requirement);
  if (unsatisfied) {
    throw new ExecutionEnvironmentError(
      "environment_requirement_unsatisfied",
      `执行环境 ${environment.id} 无法满足 ${unsatisfied} 要求`,
    );
  }
  return Object.freeze({
    environmentId: environment.id,
    capabilities: freezeCapabilities(probe.capabilities),
    evidence: Object.freeze([...probe.evidence]),
  });
}

/** 子级要求与继承要求取更严格者，禁止 Adapter 或 Child Run 放宽既有限制。 */
export function tightenExecutionEnvironmentRequirement(
  inherited: ExecutionEnvironmentRequirement,
  requested: ExecutionEnvironmentRequirement,
): ExecutionEnvironmentRequirement {
  const result: ExecutionEnvironmentRequirement = {};
  if (inherited.isolation || requested.isolation) result.isolation = "sandbox";
  result.readAccess = strongerValue(inherited.readAccess, requested.readAccess, pathAccessRank);
  result.writeAccess = strongerValue(inherited.writeAccess, requested.writeAccess, pathAccessRank);
  if (inherited.outsideWorkspaceAccess || requested.outsideWorkspaceAccess) {
    result.outsideWorkspaceAccess = "blocked";
  }
  result.networkEgress = strongerValue(
    inherited.networkEgress,
    requested.networkEgress,
    networkRequirementRank,
  );
  result.credentialIsolation = strongerValue(
    inherited.credentialIsolation,
    requested.credentialIsolation,
    credentialIsolationRank,
  );
  result.processControl = strongerValue(
    inherited.processControl,
    requested.processControl,
    processControlRank,
  );
  const kill = strongerValue(
    inherited.termination?.kill,
    requested.termination?.kill,
    processControlRank,
  );
  if (
    kill !== undefined ||
    inherited.termination?.timeout ||
    requested.termination?.timeout ||
    inherited.termination?.pty ||
    requested.termination?.pty
  ) {
    result.termination = {
      ...(kill === undefined ? {} : { kill }),
      ...(inherited.termination?.timeout || requested.termination?.timeout
        ? { timeout: true }
        : {}),
      ...(inherited.termination?.pty || requested.termination?.pty ? { pty: true } : {}),
    };
  }
  if (inherited.durability || requested.durability) result.durability = "critical";
  return Object.freeze(result);
}

export function createFakeExecutionEnvironment(input: {
  claimed: ExecutionEnvironmentCapabilityInput &
    Pick<ExecutionEnvironmentCapabilities, "networkEgress">;
  observed: ExecutionEnvironmentCapabilityInput &
    Pick<ExecutionEnvironmentCapabilities, "networkEgress">;
  probeStatus?: ExecutionEnvironmentProbe["status"];
  terminationTimeoutMs?: number;
}): ExecutionEnvironment {
  const defaults = defaultCapabilities({
    isolation: "fake",
    networkEgress: "unrestricted",
    adapter: "fake",
    adapterVersion: "test",
  });
  const claimed = mergeCapabilities(defaults, input.claimed);
  const observed = mergeCapabilities(defaults, input.observed);
  return new ManagedExecutionEnvironment({
    id: "fake",
    claimedCapabilities: claimed,
    terminationTimeoutMs: input.terminationTimeoutMs,
    probe: async () => ({
      status: input.probeStatus ?? "verified",
      capabilities: observed,
      evidence: ["fake-negative-probe"],
    }),
  });
}

export function createTrustedHostExecutionEnvironment(input: {
  workspaceRoot: string;
  platform?: NodeJS.Platform;
  probeProcessControl?: () => Promise<{
    available: boolean;
    evidence: readonly string[];
  }>;
}): ExecutionEnvironment {
  const claimedCapabilities = defaultCapabilities({
    isolation: "trusted_host",
    networkEgress: "unrestricted",
    adapter: "process-runner",
    adapterVersion: "1",
    platform: input.platform,
  });
  return new ManagedExecutionEnvironment({
    id: `trusted-host:${input.workspaceRoot}`,
    claimedCapabilities,
    probe: async () => {
      const result = await (input.probeProcessControl?.() ??
        Promise.resolve({
          available: false,
          evidence: ["process-tree-probe-missing"],
        }));
      return {
        status: result.available ? "verified" : "failed",
        capabilities: claimedCapabilities,
        evidence: result.evidence,
      };
    },
  });
}

export function createLinuxSandboxExecutionEnvironment(input: {
  workspaceRoot: string;
  platform?: NodeJS.Platform;
  probeSandbox?: () => Promise<{ available: boolean; evidence: readonly string[] }>;
  probeProcessControl?: () => Promise<{ available: boolean; evidence: readonly string[] }>;
}): ExecutionEnvironment {
  const claimedCapabilities = defaultCapabilities({
    isolation: "linux_sandbox",
    networkEgress: "deny_all",
    adapter: "sandbox-runtime",
    adapterVersion: "0.0.71",
    readAccess: "unrestricted",
    writeAccess: "workspace",
    outsideWorkspaceAccess: "allowed",
    credentialIsolation: "environment",
    processControl: "process_tree",
    termination: { kill: "process_tree", timeout: true, pty: false },
    platform: input.platform,
  });
  return new ManagedExecutionEnvironment({
    id: `linux-sandbox:${input.workspaceRoot}`,
    claimedCapabilities,
    probe: async () => {
      if ((input.platform ?? process.platform) !== "linux") {
        return {
          status: "failed",
          capabilities: claimedCapabilities,
          evidence: ["platform-not-linux"],
        };
      }
      const sandbox = await (input.probeSandbox?.() ??
        Promise.resolve({ available: false, evidence: ["sandbox-probe-missing"] }));
      const processControl = await (input.probeProcessControl?.() ??
        Promise.resolve({
          available: false,
          evidence: ["process-tree-probe-missing"],
        }));
      return {
        status: sandbox.available && processControl.available ? "verified" : "failed",
        capabilities: claimedCapabilities,
        evidence: [...sandbox.evidence, ...processControl.evidence],
      };
    },
  });
}

class ManagedExecutionEnvironment implements ExecutionEnvironment {
  readonly id: string;
  readonly claimedCapabilities: ExecutionEnvironmentCapabilities;
  private readonly activities = new Map<
    string,
    { controller: AbortController; kind: ExecutionEnvironmentActivityInput["kind"] }
  >();
  private readonly probeEnvironment: () => Promise<ExecutionEnvironmentProbe>;
  private readonly terminationTimeoutMs: number;
  private terminating = false;

  constructor(input: {
    id: string;
    claimedCapabilities: ExecutionEnvironmentCapabilities;
    probe: () => Promise<ExecutionEnvironmentProbe>;
    terminationTimeoutMs?: number;
  }) {
    this.id = input.id;
    this.claimedCapabilities = input.claimedCapabilities;
    this.probeEnvironment = input.probe;
    this.terminationTimeoutMs = input.terminationTimeoutMs ?? 5_000;
  }

  probe(): Promise<ExecutionEnvironmentProbe> {
    return this.probeEnvironment();
  }

  beginActivity(input: ExecutionEnvironmentActivityInput): ExecutionEnvironmentActivity {
    if (this.terminating || this.activities.has(input.id)) {
      throw new ExecutionEnvironmentError(
        "environment_activity_conflict",
        `执行环境 ${this.id} 不能登记活动 ${input.id}`,
      );
    }
    const controller = new AbortController();
    this.activities.set(input.id, { controller, kind: input.kind });
    let settled = false;
    return {
      signal: controller.signal,
      settle: () => {
        if (settled) return;
        settled = true;
        this.activities.delete(input.id);
      },
    };
  }

  async terminate(reason: string): Promise<void> {
    this.terminating = true;
    for (const activity of this.activities.values()) activity.controller.abort(reason);
    const deadline = performance.now() + this.terminationTimeoutMs;
    while (!this.isQuiescent() && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (!this.isQuiescent()) {
      throw new ExecutionEnvironmentError(
        "environment_terminate_failed",
        `执行环境 ${this.id} 在 ${this.terminationTimeoutMs}ms 内未终止全部活动`,
      );
    }
    this.terminating = false;
  }

  isQuiescent(): boolean {
    return this.activities.size === 0;
  }
}

function defaultCapabilities(input: {
  isolation: ExecutionEnvironmentCapabilities["isolation"];
  networkEgress: EnvironmentNetworkEgress;
  adapter: string;
  adapterVersion: string;
  readAccess?: EnvironmentPathAccess;
  writeAccess?: EnvironmentPathAccess;
  outsideWorkspaceAccess?: ExecutionEnvironmentCapabilities["outsideWorkspaceAccess"];
  credentialIsolation?: EnvironmentCredentialIsolation;
  processControl?: EnvironmentProcessControl;
  termination?: ExecutionEnvironmentTerminationCapabilities;
  durability?: EnvironmentDurability;
  platform?: NodeJS.Platform;
}): ExecutionEnvironmentCapabilities {
  return freezeCapabilities({
    isolation: input.isolation,
    readAccess: input.readAccess ?? "unrestricted",
    writeAccess: input.writeAccess ?? "unrestricted",
    outsideWorkspaceAccess: input.outsideWorkspaceAccess ?? "allowed",
    networkEgress: input.networkEgress,
    credentialIsolation: input.credentialIsolation ?? "none",
    processControl: input.processControl ?? "process_tree",
    termination: input.termination ?? {
      kill: "process_tree",
      timeout: true,
      pty: false,
    },
    durability: input.durability ?? "process_memory",
    identity: {
      platform: input.platform ?? process.platform,
      adapter: input.adapter,
      adapterVersion: input.adapterVersion,
    },
  });
}

function mergeCapabilities(
  base: ExecutionEnvironmentCapabilities,
  input: ExecutionEnvironmentCapabilityInput,
): ExecutionEnvironmentCapabilities {
  return freezeCapabilities({
    ...base,
    ...input,
    termination: { ...base.termination, ...input.termination },
    identity: { ...base.identity, ...input.identity },
  });
}

function freezeCapabilities(
  capabilities: ExecutionEnvironmentCapabilities,
): ExecutionEnvironmentCapabilities {
  return Object.freeze({
    ...capabilities,
    termination: Object.freeze({ ...capabilities.termination }),
    identity: Object.freeze({ ...capabilities.identity }),
  });
}

function capabilityMismatch(
  claimed: ExecutionEnvironmentCapabilities,
  observed: ExecutionEnvironmentCapabilities,
): string | undefined {
  if (isolationOverstated(claimed.isolation, observed.isolation)) return "隔离能力";
  if (pathAccessRank(claimed.readAccess) > pathAccessRank(observed.readAccess)) {
    return "读取路径限制";
  }
  if (pathAccessRank(claimed.writeAccess) > pathAccessRank(observed.writeAccess)) {
    return "写入路径限制";
  }
  if (
    outsideWorkspaceRank(claimed.outsideWorkspaceAccess) >
    outsideWorkspaceRank(observed.outsideWorkspaceAccess)
  ) {
    return "工作区外访问限制";
  }
  if (networkControlRank(claimed.networkEgress) > networkControlRank(observed.networkEgress)) {
    return "网络控制";
  }
  if (
    credentialIsolationRank(claimed.credentialIsolation) >
    credentialIsolationRank(observed.credentialIsolation)
  ) {
    return "凭据隔离";
  }
  if (processControlRank(claimed.processControl) > processControlRank(observed.processControl)) {
    return "进程控制";
  }
  if (
    processControlRank(claimed.termination.kill) > processControlRank(observed.termination.kill) ||
    (claimed.termination.timeout && !observed.termination.timeout) ||
    (claimed.termination.pty && !observed.termination.pty)
  ) {
    return "终止能力";
  }
  if (durabilityRank(claimed.durability) > durabilityRank(observed.durability)) {
    return "durability";
  }
  if (
    claimed.identity.platform !== observed.identity.platform ||
    claimed.identity.adapter !== observed.identity.adapter ||
    claimed.identity.adapterVersion !== observed.identity.adapterVersion
  ) {
    return "平台或 Adapter 身份";
  }
  return undefined;
}

function unsatisfiedRequirement(
  capabilities: ExecutionEnvironmentCapabilities,
  requirement: ExecutionEnvironmentRequirement,
): string | undefined {
  if (requirement.isolation === "sandbox" && capabilities.isolation !== "linux_sandbox") {
    return "sandbox 隔离";
  }
  if (
    requirement.readAccess &&
    pathAccessRank(capabilities.readAccess) < pathAccessRank(requirement.readAccess)
  ) {
    return "读取路径限制";
  }
  if (
    requirement.writeAccess &&
    pathAccessRank(capabilities.writeAccess) < pathAccessRank(requirement.writeAccess)
  ) {
    return "写入路径限制";
  }
  if (
    requirement.outsideWorkspaceAccess === "blocked" &&
    capabilities.outsideWorkspaceAccess !== "blocked"
  ) {
    return "工作区外访问限制";
  }
  if (
    requirement.networkEgress &&
    networkControlRank(capabilities.networkEgress) <
      networkRequirementCapabilityRank(requirement.networkEgress)
  ) {
    return "网络 egress";
  }
  if (
    requirement.credentialIsolation &&
    credentialIsolationRank(capabilities.credentialIsolation) <
      credentialIsolationRank(requirement.credentialIsolation)
  ) {
    return "凭据隔离";
  }
  if (
    requirement.processControl &&
    processControlRank(capabilities.processControl) < processControlRank(requirement.processControl)
  ) {
    return "进程控制";
  }
  if (
    (requirement.termination?.kill &&
      processControlRank(capabilities.termination.kill) <
        processControlRank(requirement.termination.kill)) ||
    (requirement.termination?.timeout && !capabilities.termination.timeout) ||
    (requirement.termination?.pty && !capabilities.termination.pty)
  ) {
    return "终止能力";
  }
  if (requirement.durability === "critical" && capabilities.durability !== "critical") {
    return "critical durability";
  }
  return undefined;
}

function isolationOverstated(
  claimed: ExecutionEnvironmentCapabilities["isolation"],
  observed: ExecutionEnvironmentCapabilities["isolation"],
): boolean {
  if (claimed === "fake" || observed === "fake") return claimed !== observed;
  return isolationRank(claimed) > isolationRank(observed);
}

function isolationRank(
  value: Exclude<ExecutionEnvironmentCapabilities["isolation"], "fake">,
): number {
  return value === "linux_sandbox" ? 1 : 0;
}

function pathAccessRank(value: EnvironmentPathAccess): number {
  return value === "none" ? 2 : value === "workspace" ? 1 : 0;
}

function outsideWorkspaceRank(
  value: ExecutionEnvironmentCapabilities["outsideWorkspaceAccess"],
): number {
  return value === "blocked" ? 1 : 0;
}

function credentialIsolationRank(value: EnvironmentCredentialIsolation): number {
  return value === "environment_and_files" ? 2 : value === "environment" ? 1 : 0;
}

function processControlRank(value: EnvironmentProcessControl): number {
  return value === "process_tree" ? 2 : value === "process" ? 1 : 0;
}

function durabilityRank(value: EnvironmentDurability): number {
  return value === "critical" ? 1 : 0;
}

function networkRequirementRank(
  value: NonNullable<ExecutionEnvironmentRequirement["networkEgress"]>,
): number {
  return value === "denied" ? 2 : 1;
}

function networkRequirementCapabilityRank(
  value: NonNullable<ExecutionEnvironmentRequirement["networkEgress"]>,
): number {
  return value === "denied" ? networkControlRank("deny_all") : networkControlRank("adapter_scoped");
}

function strongerValue<T>(
  left: T | undefined,
  right: T | undefined,
  rank: (value: T) => number,
): T | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return rank(left) >= rank(right) ? left : right;
}

function networkControlRank(value: EnvironmentNetworkEgress): number {
  switch (value) {
    case "unrestricted":
      return 0;
    case "adapter_scoped":
      return 1;
    case "allowlist":
      return 2;
    case "deny_all":
      return 3;
  }
}

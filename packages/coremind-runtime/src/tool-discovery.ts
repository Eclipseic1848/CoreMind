import { randomUUID } from "node:crypto";
import type { ToolEffectDeclaration } from "coremind-config";
import type { ResolvedToolCapability } from "coremind-tools";
import type { AgentDriverObservation, AgentDriverToolResult } from "./agent-driver.js";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import { CoreMindError } from "./errors.js";
import type { FactDurabilityReceipt } from "./fact-ledger.js";
import type { RunStateRecord } from "./run-state.js";

export const DISCOVER_TOOLS_NAME = "discover_tools";
const MAX_ENTRIES = 256;
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;
const restoredStates = new WeakSet<ToolDiscoveryRestored>();

export interface ToolDiscoveryOwner {
  readonly runId: string;
  readonly agent: string;
  readonly stepId?: string;
  readonly executionId: string;
}

export interface ToolDiscoveryEntry {
  readonly name: string;
  readonly description: string;
  readonly exposure: "direct" | "deferred";
  readonly sourceIdentity: string;
  readonly declaration: Readonly<Record<string, unknown>>;
  readonly effect: ToolEffectDeclaration;
  readonly capability: ResolvedToolCapability;
}

export interface ToolDiscoveryCatalog {
  readonly version: 1;
  readonly owner: ToolDiscoveryOwner;
  readonly entries: readonly ToolDiscoveryEntry[];
  readonly fingerprint: string;
}

export interface ToolDiscoverySearchFact {
  readonly version: 1;
  readonly owner: ToolDiscoveryOwner;
  readonly callId: string;
  readonly catalogFingerprint: string;
  readonly queryFingerprint: string;
  readonly entries: readonly string[];
}

export interface ToolDiscoverySelection {
  readonly version: 1;
  readonly owner: ToolDiscoveryOwner;
  readonly catalogFingerprint: string;
  readonly generation: number;
  readonly previousFingerprint?: string;
  readonly names: readonly string[];
  readonly withdrawnSources: readonly string[];
  readonly fingerprint: string;
}

export interface ToolDiscoveryPrepared {
  readonly eventId: string;
  readonly catalog?: ToolDiscoveryCatalog;
  readonly selection: ToolDiscoverySelection;
}

export interface ToolDiscoveryCallBinding {
  readonly owner: ToolDiscoveryOwner;
  readonly name: string;
  readonly entryFingerprint: string;
  readonly sourceIdentity: string;
  readonly sourceEpoch: number;
}

export interface ToolDiscoveryRestored {
  readonly catalog: ToolDiscoveryCatalog;
  readonly selections: readonly ToolDiscoverySelection[];
  readonly searches: readonly ToolDiscoverySearchFact[];
}

interface SearchCandidate {
  argsFingerprint: string;
  result: AgentDriverToolResult;
  fact: ToolDiscoverySearchFact;
}

/** 每次执行独占允许目录和声明；持久化及真实工具对象仍由 Runtime 和 Adapter 拥有。 */
export class ToolDiscoveryExecution {
  readonly catalog: ToolDiscoveryCatalog;
  private selection?: ToolDiscoverySelection;
  private catalogPublished = false;
  private revision = 0;
  private readonly withdrawn = new Set<string>();
  private readonly entries = new Map<string, ToolDiscoveryEntry>();
  private readonly fingerprints = new Map<string, string>();
  private readonly byFingerprint = new Map<string, ToolDiscoveryEntry>();
  private readonly candidates = new Map<string, SearchCandidate>();
  private readonly successes = new Map<string, ToolDiscoverySearchFact>();
  private readonly plans = new WeakMap<ToolDiscoveryPrepared, number>();
  private restoredSearches: readonly ToolDiscoverySearchFact[] = [];
  private pending?: ToolDiscoveryPrepared;

  constructor(input: {
    owner: ToolDiscoveryOwner;
    entries: readonly ToolDiscoveryEntry[];
    restored?: ToolDiscoveryRestored;
  }) {
    this.catalog = catalogOf(input.owner, input.entries);
    for (const entry of this.catalog.entries) {
      const fingerprint = entryFingerprint(entry);
      this.entries.set(entry.name, entry);
      this.fingerprints.set(entry.name, fingerprint);
      this.byFingerprint.set(fingerprint, entry);
    }
    if (input.restored) {
      if (!restoredStates.has(input.restored)) throw corrupt();
      if (input.restored.catalog.fingerprint !== this.catalog.fingerprint) throw changed();
      this.catalogPublished = true;
      this.selection = input.restored.selections.at(-1);
      this.restoredSearches = input.restored.searches;
      for (const source of this.selection?.withdrawnSources ?? []) this.withdrawn.add(source);
      for (const fact of input.restored.searches) this.successes.set(fact.callId, fact);
    }
  }

  get current(): ToolDiscoverySelection | undefined {
    return this.selection;
  }

  search(callId: string, args: unknown, signal?: AbortSignal): AgentDriverToolResult {
    if (signal?.aborted) throw new CoreMindError("aborted", "工具发现已取消");
    if (
      !nonempty(callId) ||
      !object(args) ||
      Object.keys(args).some((key) => key !== "query" && key !== "limit") ||
      typeof args.query !== "string" ||
      !args.query.trim() ||
      [...args.query].length > 256
    )
      throw invalid();
    const limit = args.limit === undefined ? 5 : args.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 8) throw invalid();
    const argsFingerprint = fingerprintEffectReceiptValue(args);
    const previous = this.candidates.get(callId);
    if (previous) {
      if (previous.argsFingerprint !== argsFingerprint) throw changed();
      return previous.result;
    }
    const query = normalize(args.query.trim());
    const terms = tokenize(query);
    const declared = new Set(this.selection?.names ?? []);
    const ranked = this.catalog.entries
      .filter(
        (entry) =>
          entry.exposure === "deferred" &&
          !declared.has(entry.name) &&
          !this.withdrawn.has(entry.sourceIdentity),
      )
      .map((entry) => ({ entry, score: score(entry, query, terms) }))
      .filter((match) => match.score > 0)
      .sort(
        (left, right) => right.score - left.score || compare(left.entry.name, right.entry.name),
      );
    const matches: Array<{ name: string; description: string; entryFingerprint: string }> = [];
    for (const { entry } of ranked.slice(0, limit as number)) {
      const characters = [...entry.description];
      const match = {
        name: entry.name,
        description:
          characters.length > 1024 ? characters.slice(0, 1024).join("") + "…" : entry.description,
        entryFingerprint: this.fingerprints.get(entry.name)!,
      };
      const next = render([...matches, match], ranked.length > matches.length + 1);
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_RESULT_BYTES) break;
      matches.push(match);
    }
    const result = freeze(render(matches, ranked.length > matches.length));
    const fact = freeze({
      version: 1 as const,
      owner: this.catalog.owner,
      callId,
      catalogFingerprint: this.catalog.fingerprint,
      queryFingerprint: fingerprintEffectReceiptValue({ query, limit }),
      entries: matches.map((match) => match.entryFingerprint),
    });
    this.candidates.set(callId, { argsFingerprint, result, fact });
    return result;
  }

  observe(observation: AgentDriverObservation): ToolDiscoverySearchFact | undefined {
    if (observation.type !== "tool_execution_end") return undefined;
    const candidate = this.candidates.get(observation.call.callId);
    this.candidates.delete(observation.call.callId);
    if (
      !candidate ||
      observation.isError ||
      observation.call.tool !== DISCOVER_TOOLS_NAME ||
      !object(observation.call.args)
    )
      return undefined;
    try {
      if (
        fingerprintEffectReceiptValue(observation.call.args) !== candidate.argsFingerprint ||
        fingerprintEffectReceiptValue(observation.result) !==
          fingerprintEffectReceiptValue(candidate.result)
      )
        return undefined;
    } catch {
      return undefined;
    }
    this.successes.set(candidate.fact.callId, candidate.fact);
    return candidate.fact;
  }

  prepare(durableSearches: readonly ToolDiscoverySearchFact[]): ToolDiscoveryPrepared | undefined {
    const names = new Set(
      this.selection?.names ??
        this.catalog.entries
          .filter((entry) => entry.exposure === "direct")
          .map((entry) => entry.name),
    );
    for (const fact of [...this.restoredSearches, ...durableSearches]) {
      const known = this.successes.get(fact.callId);
      if (!known || fingerprintEffectReceiptValue(known) !== fingerprintEffectReceiptValue(fact))
        throw corrupt();
      for (const fingerprint of fact.entries) names.add(this.byFingerprint.get(fingerprint)!.name);
    }
    const selected = this.catalog.entries
      .filter((entry) => names.has(entry.name) && !this.withdrawn.has(entry.sourceIdentity))
      .map((entry) => entry.name);
    const withdrawnSources = [...this.withdrawn].sort(compare);
    if (
      this.selection &&
      equal(this.selection.names, selected) &&
      equal(this.selection.withdrawnSources, withdrawnSources)
    )
      return undefined;
    const value = {
      version: 1 as const,
      owner: this.catalog.owner,
      catalogFingerprint: this.catalog.fingerprint,
      generation: this.selection ? this.selection.generation + 1 : 0,
      ...(this.selection ? { previousFingerprint: this.selection.fingerprint } : {}),
      names: selected,
      withdrawnSources,
    };
    const selection = freeze({ ...value, fingerprint: fingerprintEffectReceiptValue(value) });
    if (
      this.pending?.selection.fingerprint === selection.fingerprint &&
      this.plans.get(this.pending) === this.revision
    )
      return this.pending;
    const prepared = freeze({
      eventId: randomUUID(),
      ...(!this.catalogPublished ? { catalog: this.catalog } : {}),
      selection,
    });
    this.plans.set(prepared, this.revision);
    this.pending = prepared;
    return prepared;
  }

  commit(prepared: ToolDiscoveryPrepared, receipt: FactDurabilityReceipt): void {
    if (
      this.plans.get(prepared) !== this.revision ||
      prepared !== this.pending ||
      prepared.selection.generation !== (this.selection ? this.selection.generation + 1 : 0) ||
      prepared.selection.previousFingerprint !== this.selection?.fingerprint
    )
      throw changed();
    if (
      receipt.runId !== this.catalog.owner.runId ||
      receipt.eventId !== prepared.eventId ||
      receipt.kind !== "event" ||
      receipt.durability !== "critical" ||
      receipt.acknowledgement.requested !== "critical" ||
      receipt.acknowledgement.achieved !== "critical"
    )
      throw changed();
    this.selection = prepared.selection;
    this.catalogPublished = true;
    this.plans.delete(prepared);
    this.pending = undefined;
  }

  withdraw(sourceIdentity: string): void {
    if (
      this.withdrawn.has(sourceIdentity) ||
      !this.catalog.entries.some((entry) => entry.sourceIdentity === sourceIdentity)
    )
      return;
    this.withdrawn.add(sourceIdentity);
    this.revision++;
  }

  assertCallable(name: string, expected?: ToolDiscoveryCallBinding): ToolDiscoveryCallBinding {
    const entry = this.entries.get(name);
    if (
      expected &&
      (!sameOwner(expected.owner, this.catalog.owner) ||
        expected.name !== name ||
        expected.entryFingerprint !== this.fingerprints.get(name) ||
        expected.sourceIdentity !== entry?.sourceIdentity ||
        expected.sourceEpoch !== (entry && this.withdrawn.has(entry.sourceIdentity) ? 1 : 0))
    )
      throw changed();
    if (
      !entry ||
      this.withdrawn.has(entry.sourceIdentity) ||
      !this.selection?.names.includes(name)
    ) {
      if (expected) throw changed();
      throw invalid();
    }
    return freeze({
      owner: this.catalog.owner,
      name,
      entryFingerprint: this.fingerprints.get(name)!,
      sourceIdentity: entry.sourceIdentity,
      sourceEpoch: 0,
    });
  }
}

/** 只折叠本逻辑执行的私有追加事实；旧 Run 没有字段时不推测历史声明。 */
export function restoreToolDiscovery(
  records: readonly RunStateRecord[],
  owner: ToolDiscoveryOwner,
): ToolDiscoveryRestored | undefined {
  validateOwner(owner);
  let catalog: ToolDiscoveryCatalog | undefined;
  const selections: ToolDiscoverySelection[] = [];
  const searches: ToolDiscoverySearchFact[] = [];
  const byFingerprint = new Map<string, ToolDiscoveryEntry>();
  const knownSearches = new Map<string, ToolDiscoverySearchFact>();
  for (const record of records) {
    if (record.runId !== owner.runId || record.kind !== "event" || !object(record.payload))
      continue;
    const payload = record.payload;
    if (owned(payload.toolDiscoveryCatalog, owner)) {
      if (catalog) throw corrupt();
      const value = payload.toolDiscoveryCatalog;
      if (
        !object(value) ||
        !keys(value, ["version", "owner", "entries", "fingerprint"]) ||
        value.version !== 1 ||
        !Array.isArray(value.entries)
      )
        throw corrupt();
      try {
        catalog = catalogOf(owner, value.entries as ToolDiscoveryEntry[]);
      } catch {
        throw corrupt();
      }
      if (catalog.fingerprint !== value.fingerprint) throw corrupt();
      for (const entry of catalog.entries) byFingerprint.set(entryFingerprint(entry), entry);
    }
    if (owned(payload.toolDiscoverySearch, owner)) {
      const value = payload.toolDiscoverySearch;
      if (
        !catalog ||
        !object(value) ||
        !keys(value, [
          "version",
          "owner",
          "callId",
          "catalogFingerprint",
          "queryFingerprint",
          "entries",
        ]) ||
        value.version !== 1 ||
        !nonempty(value.callId) ||
        value.catalogFingerprint !== catalog.fingerprint ||
        !hash(value.queryFingerprint) ||
        !Array.isArray(value.entries) ||
        value.entries.length > 8 ||
        new Set(value.entries).size !== value.entries.length ||
        value.entries.some(
          (entry) => typeof entry !== "string" || byFingerprint.get(entry)?.exposure !== "deferred",
        )
      )
        throw corrupt();
      const event = payload.event;
      if (
        !object(event) ||
        event.type !== "tool_result" ||
        event.agent !== owner.agent ||
        event.stepId !== owner.stepId ||
        event.callId !== value.callId ||
        event.tool !== DISCOVER_TOOLS_NAME ||
        event.isError !== false
      )
        throw corrupt();
      if (knownSearches.has(value.callId)) throw corrupt();
      const fact = freeze(copy(value) as unknown as ToolDiscoverySearchFact);
      knownSearches.set(fact.callId, fact);
      searches.push(fact);
    }
    if (owned(payload.toolDiscoverySelection, owner)) {
      if (!catalog) throw corrupt();
      const value = payload.toolDiscoverySelection;
      const previous = selections.at(-1);
      if (
        !object(value) ||
        !keys(value, [
          "version",
          "owner",
          "catalogFingerprint",
          "generation",
          "previousFingerprint",
          "names",
          "withdrawnSources",
          "fingerprint",
        ]) ||
        value.version !== 1 ||
        value.catalogFingerprint !== catalog.fingerprint ||
        value.generation !== selections.length ||
        value.previousFingerprint !== previous?.fingerprint ||
        !strings(value.names) ||
        !strings(value.withdrawnSources) ||
        new Set(value.names).size !== value.names.length ||
        new Set(value.withdrawnSources).size !== value.withdrawnSources.length
      )
        throw corrupt();
      const names = value.names;
      const withdrawnSources = value.withdrawnSources;
      const sources = new Set(catalog.entries.map((entry) => entry.sourceIdentity));
      if (
        withdrawnSources.some((source) => !sources.has(source)) ||
        !equal(withdrawnSources, [...withdrawnSources].sort(compare)) ||
        previous?.withdrawnSources.some((source) => !withdrawnSources.includes(source))
      )
        throw corrupt();
      const allowed = new Set(
        previous?.names ??
          catalog.entries.filter((entry) => entry.exposure === "direct").map((entry) => entry.name),
      );
      for (const fact of searches)
        for (const fingerprint of fact.entries) allowed.add(byFingerprint.get(fingerprint)!.name);
      const expected = catalog.entries
        .filter(
          (entry) => allowed.has(entry.name) && !withdrawnSources.includes(entry.sourceIdentity),
        )
        .map((entry) => entry.name);
      const { fingerprint, ...body } = value;
      if (!equal(names, expected) || fingerprint !== fingerprintEffectReceiptValue(body))
        throw corrupt();
      selections.push(freeze(copy(value) as unknown as ToolDiscoverySelection));
    }
  }
  if (!catalog) return undefined;
  const restored = freeze({ catalog, selections, searches });
  restoredStates.add(restored);
  return restored;
}

/** 只沿最终明确暂停的执行绑定恢复；崩溃前缀不能猜测旧 activation。 */
export function restoreToolDiscoveryContinuations(
  records: readonly RunStateRecord[],
  runId: string,
): readonly ToolDiscoveryOwner[] {
  const last = records.at(-1);
  if (last?.kind !== "pause" || !object(last.payload)) return [];
  const value = last.payload.toolDiscoveryContinuations;
  if (value === undefined) return [];
  if (
    last.runId !== runId ||
    !object(value) ||
    !keys(value, ["version", "owners"]) ||
    value.version !== 1 ||
    !Array.isArray(value.owners)
  )
    throw corrupt();
  const scopes = new Set<string>();
  const executions = new Set<string>();
  const owners: ToolDiscoveryOwner[] = [];
  for (const candidate of value.owners) {
    validateOwner(candidate as ToolDiscoveryOwner);
    const owner = candidate as ToolDiscoveryOwner;
    const scope = JSON.stringify([owner.agent, owner.stepId]);
    if (owner.runId !== runId || scopes.has(scope) || executions.has(owner.executionId))
      throw corrupt();
    scopes.add(scope);
    executions.add(owner.executionId);
    const restored = restoreToolDiscovery(records, owner);
    if (!restored?.selections.length) throw corrupt();
    owners.push(owner);
  }
  return freeze(copy(owners));
}

function invalid() {
  return new CoreMindError("invalid_tool", "工具不在当前声明集合");
}
function changed() {
  return new CoreMindError("tool_capability_conflict", "工具目录或声明身份已变化");
}
function corrupt() {
  return new CoreMindError("run_state_corrupt", "工具发现事实缺失、损坏或身份不匹配");
}

function catalogOf(
  owner: ToolDiscoveryOwner,
  entries: readonly ToolDiscoveryEntry[],
): ToolDiscoveryCatalog {
  validateOwner(owner);
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw invalid();
  const names = new Set<string>();
  let bytes = 0;
  for (const entry of entries) {
    if (
      !object(entry) ||
      !keys(entry, [
        "name",
        "description",
        "exposure",
        "sourceIdentity",
        "declaration",
        "effect",
        "capability",
      ]) ||
      !nonempty(entry.name) ||
      entry.name === DISCOVER_TOOLS_NAME ||
      names.has(entry.name) ||
      typeof entry.description !== "string" ||
      (entry.exposure !== "direct" && entry.exposure !== "deferred") ||
      !nonempty(entry.sourceIdentity) ||
      !object(entry.declaration) ||
      entry.declaration.name !== entry.name ||
      entry.declaration.description !== entry.description ||
      !object(entry.declaration.parameters) ||
      !object(entry.effect) ||
      !object(entry.capability)
    )
      throw invalid();
    names.add(entry.name);
    try {
      bytes += Buffer.byteLength(JSON.stringify(entry.declaration), "utf8");
    } catch {
      throw invalid();
    }
    if (bytes > MAX_SCHEMA_BYTES) throw invalid();
  }
  const value = { version: 1 as const, owner: copy(owner), entries: copy(entries) };
  return freeze({ ...value, fingerprint: fingerprintEffectReceiptValue(value) });
}

function entryFingerprint(entry: ToolDiscoveryEntry): string {
  return fingerprintEffectReceiptValue({
    sourceIdentity: entry.sourceIdentity,
    name: entry.name,
    declaration: entry.declaration,
    effect: entry.effect,
    capability: entry.capability,
  });
}

function render(matches: unknown[], truncated: boolean): AgentDriverToolResult {
  const details = { matches, truncated };
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function tokenize(value: string): string[] {
  const terms = new Set<string>();
  for (const part of value.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (/^\p{Script=Han}/u.test(part)) {
      const characters = [...part];
      if (characters.length === 1) terms.add(part);
      else
        for (let index = 0; index < characters.length - 1; index++)
          terms.add(characters[index]! + characters[index + 1]!);
    } else terms.add(part);
  }
  return [...terms];
}

function score(entry: ToolDiscoveryEntry, query: string, terms: string[]): number {
  const name = normalize(entry.name);
  const description = normalize(entry.description);
  return (
    (name === query ? 1_000_000 : 0) +
    (name.startsWith(query) ? 100_000 : 0) +
    (name.includes(query) ? 10_000 : 0) +
    terms.reduce(
      (total, term) =>
        total + (name.includes(term) ? 100 : 0) + (description.includes(term) ? 1 : 0),
      0,
    ) +
    (description.includes(query) ? 10 : 0)
  );
}

function compare(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}

function validateOwner(owner: ToolDiscoveryOwner): void {
  if (
    !object(owner) ||
    !nonempty(owner.runId) ||
    !nonempty(owner.agent) ||
    !nonempty(owner.executionId) ||
    (owner.stepId !== undefined && !nonempty(owner.stepId)) ||
    Object.keys(owner).some((key) => !["runId", "agent", "stepId", "executionId"].includes(key))
  )
    throw corrupt();
}

function owned(value: unknown, owner: ToolDiscoveryOwner): boolean {
  if (value === undefined) return false;
  if (!object(value) || !object(value.owner)) throw corrupt();
  validateOwner(value.owner as unknown as ToolDiscoveryOwner);
  return sameOwner(value.owner as unknown as ToolDiscoveryOwner, owner);
}

function sameOwner(left: ToolDiscoveryOwner, right: ToolDiscoveryOwner): boolean {
  return (
    left.runId === right.runId &&
    left.agent === right.agent &&
    left.stepId === right.stepId &&
    left.executionId === right.executionId
  );
}
function equal(left: unknown, right: unknown): boolean {
  return fingerprintEffectReceiptValue(left) === fingerprintEffectReceiptValue(right);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty);
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function copy<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    throw invalid();
  }
}

function freeze<T>(value: T, depth = 0): T {
  if (depth > 64) throw invalid();
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child, depth + 1);
    Object.freeze(value);
  }
  return value;
}

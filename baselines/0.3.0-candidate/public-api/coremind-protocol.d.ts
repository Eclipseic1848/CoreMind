import { Static } from '@sinclair/typebox';
import { TArray } from '@sinclair/typebox';
import { TBoolean } from '@sinclair/typebox';
import { TInteger } from '@sinclair/typebox';
import { TLiteral } from '@sinclair/typebox';
import { TNumber } from '@sinclair/typebox';
import { TObject } from '@sinclair/typebox';
import { TOptional } from '@sinclair/typebox';
import { TRecord } from '@sinclair/typebox';
import { TString } from '@sinclair/typebox';
import { TUnion } from '@sinclair/typebox';
import { TUnknown } from '@sinclair/typebox';

export declare const ApproveRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"approve">;
params: TObject<    {
runId: TString;
approvalId: TString;
decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
}>;
}>;

export declare const CancelRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"cancel">;
params: TObject<    {
runId: TString;
}>;
}>;

export declare const ChatRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"chat">;
params: TObject<    {
agent: TString;
message: TString;
runId: TOptional<TString>;
}>;
}>;

export declare const CheckpointDiffRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"checkpoint_diff">;
params: TObject<    {
runId: TString;
checkpointId: TString;
}>;
}>;

export declare const CheckpointRestoreRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"checkpoint_restore">;
params: TObject<    {
runId: TString;
checkpointId: TString;
confirm: TLiteral<true>;
}>;
}>;

export declare const CloseRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"close">;
params: TObject<    {}>;
}>;

export declare function createErrorResponse(id: RpcId, code: number, message: string, coremindCode?: string, details?: unknown): ProtocolErrorResponse;

export declare function createEventNotification(params: Omit<ProtocolEventNotification["params"], "protocolVersion">): ProtocolEventNotification;

export declare function createPythonToolCallNotification(params: Omit<PythonToolCallNotification["params"], "protocolVersion">): PythonToolCallNotification;

export declare function createSuccessResponse(id: RpcId, result: unknown): ProtocolSuccessResponse;

export declare type InitializeRequest = Static<typeof InitializeRequestSchema>;

export declare const InitializeRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"initialize">;
params: TObject<    {
protocolVersion: TLiteral<"1.0">;
config: TOptional<TUnknown>;
configPath: TOptional<TString>;
configDir: TOptional<TString>;
cwd: TOptional<TString>;
sessionId: TOptional<TString>;
}>;
}>;

export declare const InspectRunRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"inspect_run">;
params: TObject<    {
runId: TString;
}>;
}>;

export declare function parseProtocolRequest(value: unknown): ProtocolRequest;

export declare function parseRunSnapshot(value: unknown): ProtocolRunSnapshot;

export declare const PROTOCOL_VERSION: "1.0";

export declare type ProtocolErrorResponse = Static<typeof ProtocolErrorResponseSchema>;

export declare const ProtocolErrorResponseSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
error: TObject<    {
code: TInteger;
message: TString;
data: TOptional<TObject<    {
coremindCode: TOptional<TString>;
details: TOptional<TUnknown>;
}>>;
}>;
}>;

export declare type ProtocolEventNotification = Static<typeof ProtocolEventNotificationSchema>;

export declare const ProtocolEventNotificationSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
method: TLiteral<"event">;
params: TObject<    {
protocolVersion: TLiteral<"1.0">;
runId: TString;
sequence: TInteger;
timestamp: TString;
event: TUnknown;
}>;
}>;

export declare type ProtocolRequest = Static<typeof ProtocolRequestSchema>;

export declare const ProtocolRequestSchema: TUnion<[TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"initialize">;
params: TObject<    {
protocolVersion: TLiteral<"1.0">;
config: TOptional<TUnknown>;
configPath: TOptional<TString>;
configDir: TOptional<TString>;
cwd: TOptional<TString>;
sessionId: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"run">;
params: TObject<    {
input: TOptional<TString>;
qualityOverride: TOptional<TBoolean>;
runId: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"chat">;
params: TObject<    {
agent: TString;
message: TString;
runId: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"cancel">;
params: TObject<    {
runId: TString;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"approve">;
params: TObject<    {
runId: TString;
approvalId: TString;
decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"register_tool">;
params: TObject<    {
name: TString;
description: TString;
parameters: TUnknown;
effect: TObject<    {
operations: TArray<TUnion<[TLiteral<"read">, TLiteral<"write">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">]>>;
reversible: TBoolean;
pathFields: TOptional<TArray<TString>>;
urlFields: TOptional<TArray<TString>>;
}>;
label: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"tool_result">;
params: TObject<    {
callId: TString;
result: TOptional<TUnknown>;
error: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"inspect_run">;
params: TObject<    {
runId: TString;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"resume_run">;
params: TObject<    {
runId: TString;
input: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"checkpoint_diff">;
params: TObject<    {
runId: TString;
checkpointId: TString;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"checkpoint_restore">;
params: TObject<    {
runId: TString;
checkpointId: TString;
confirm: TLiteral<true>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"close">;
params: TObject<    {}>;
}>]>;

export declare type ProtocolRunSnapshot = Static<typeof RunSnapshotSchema>;

export declare type ProtocolSuccessResponse = Static<typeof ProtocolSuccessResponseSchema>;

export declare const ProtocolSuccessResponseSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
result: TUnknown;
}>;

export declare class ProtocolValidationError extends Error {
    constructor(message: string);
}

export declare type PythonToolCallNotification = Static<typeof PythonToolCallNotificationSchema>;

export declare const PythonToolCallNotificationSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
method: TLiteral<"python_tool_call">;
params: TObject<    {
protocolVersion: TLiteral<"1.0">;
runId: TString;
callId: TString;
tool: TString;
args: TUnknown;
}>;
}>;

export declare const RegisterToolRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"register_tool">;
params: TObject<    {
name: TString;
description: TString;
parameters: TUnknown;
effect: TObject<    {
operations: TArray<TUnion<[TLiteral<"read">, TLiteral<"write">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">]>>;
reversible: TBoolean;
pathFields: TOptional<TArray<TString>>;
urlFields: TOptional<TArray<TString>>;
}>;
label: TOptional<TString>;
}>;
}>;

export declare const ResumeRunRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"resume_run">;
params: TObject<    {
runId: TString;
input: TOptional<TString>;
}>;
}>;

export declare type RpcId = Static<typeof RpcIdSchema>;

declare const RpcIdSchema: TUnion<[TString, TNumber]>;

export declare const RunRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"run">;
params: TObject<    {
input: TOptional<TString>;
qualityOverride: TOptional<TBoolean>;
runId: TOptional<TString>;
}>;
}>;

/** Worker、TypeScript SDK 与 Python SDK 共享的运行快照信封。 */
export declare const RunSnapshotSchema: TObject<    {
schemaVersion: TLiteral<1>;
runId: TString;
operation: TObject<    {
schemaVersion: TLiteral<1>;
operationId: TString;
runId: TString;
correlationId: TString;
state: TUnion<[TLiteral<"accepted">, TLiteral<"running">, TLiteral<"paused">, TLiteral<"aborting">, TLiteral<"completed">, TLiteral<"failed">]>;
transitionSequence: TInteger;
createdAt: TString;
updatedAt: TString;
pauseReason: TOptional<TString>;
failureReason: TOptional<TString>;
}>;
outcome: TObject<    {
status: TUnion<[TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"paused">, TLiteral<"aborted">, TLiteral<"timeout">, TLiteral<"budget_exceeded">]>;
finishReason: TString;
error: TOptional<TObject<    {
code: TString;
message: TString;
}>>;
}>;
metrics: TObject<    {
durationMs: TNumber;
turns: TInteger;
steps: TObject<    {
total: TInteger;
succeeded: TInteger;
failed: TInteger;
}>;
toolCalls: TInteger;
toolFailures: TInteger;
retries: TInteger;
tokens: TOptional<TNumber>;
costUsd: TOptional<TNumber>;
outputChars: TInteger;
context: TOptional<TObject<    {
inputTokens: TInteger;
outputTokens: TInteger;
cacheReadTokens: TInteger;
cacheWriteTokens: TInteger;
promptCacheStatus: TUnion<[TLiteral<"available">, TLiteral<"unavailable">, TLiteral<"unknown">]>;
compactions: TInteger;
lastSummaryFingerprint: TOptional<TString>;
stablePrefixFingerprints: TArray<TString>;
lastBudget: TOptional<TObject<    {
providerId: TString;
modelId: TString;
capabilityFingerprint: TString;
source: TUnion<[TLiteral<"locked_catalog">, TLiteral<"explicit_config">, TLiteral<"provider_metadata">, TLiteral<"conservative_fallback">]>;
confidence: TUnion<[TLiteral<"verified">, TLiteral<"declared">, TLiteral<"assumed">]>;
effectiveContextWindow: TInteger;
reservedOutputTokens: TInteger;
availableInputTokens: TInteger;
messageTokens: TInteger;
estimator: TLiteral<"pi-agent-core-estimate-v1">;
}>>;
}>>;
artifacts: TOptional<TObject<    {
stored: TInteger;
blocked: TInteger;
totalBytes: TInteger;
}>>;
}>;
evaluation: TObject<    {
profile: TUnion<[TLiteral<"development">, TLiteral<"standard">, TLiteral<"strict">]>;
scenarioResults: TArray<TObject<    {
id: TString;
passed: TBoolean;
score: TOptional<TNumber>;
reason: TOptional<TString>;
}>>;
qualityScores: TRecord<TString, TNumber>;
securityFindings: TArray<TString>;
}>;
releaseReadiness: TObject<    {
ready: TBoolean;
blockers: TArray<TString>;
warnings: TArray<TString>;
overrideRecord: TOptional<TObject<    {
reason: TString;
recordedAt: TString;
}>>;
}>;
trace: TArray<TObject<    {
eventId: TString;
runId: TString;
sequence: TInteger;
timestamp: TString;
event: TObject<    {
type: TString;
}>;
}>>;
checkpoints: TArray<TObject<    {
version: TLiteral<1>;
checkpointId: TString;
runId: TString;
operationId: TOptional<TString>;
toolCallId: TOptional<TString>;
idempotencyKey: TOptional<TString>;
timestamp: TString;
tool: TString;
reversible: TBoolean;
targetPath: TOptional<TString>;
existed: TOptional<TBoolean>;
beforeSha256: TOptional<TString>;
afterExisted: TOptional<TBoolean>;
afterSha256: TOptional<TString>;
reason: TOptional<TString>;
snapshotFile: TString;
}>>;
artifacts: TArray<TObject<    {
artifactId: TString;
status: TUnion<[TLiteral<"stored">, TLiteral<"blocked">]>;
relativePath: TOptional<TString>;
sizeBytes: TInteger;
sha256: TOptional<TString>;
mediaType: TString;
createdAt: TString;
retention: TLiteral<"run">;
redaction: TUnion<[TLiteral<"none">, TLiteral<"blocked-secret">]>;
}>>;
extensions: TArray<TObject<    {
extensionId: TString;
extensionVersion: TString;
event: TUnion<[TLiteral<"before-model">, TLiteral<"before-tool">, TLiteral<"after-tool">, TLiteral<"run-finished">]>;
status: TUnion<[TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"timed_out">]>;
durationMs: TNumber;
error: TOptional<TString>;
denied: TOptional<TBoolean>;
}>>;
resumable: TBoolean;
}>;

export declare const ToolResultRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"tool_result">;
params: TObject<    {
callId: TString;
result: TOptional<TUnknown>;
error: TOptional<TString>;
}>;
}>;

export { }

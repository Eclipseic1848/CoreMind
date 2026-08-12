import { Static } from '@sinclair/typebox';
import { TArray } from '@sinclair/typebox';
import { TBoolean } from '@sinclair/typebox';
import { TInteger } from '@sinclair/typebox';
import { TLiteral } from '@sinclair/typebox';
import { TNumber } from '@sinclair/typebox';
import { TObject } from '@sinclair/typebox';
import { TOptional } from '@sinclair/typebox';
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
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"chat">;
params: TObject<    {
agent: TString;
message: TString;
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
}>;
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

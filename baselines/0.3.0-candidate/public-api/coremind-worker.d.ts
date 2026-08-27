import { ControlReceipt } from 'coremind-ai';
import { CoreMindRuntime } from 'coremind-ai';
import { CoreMindRuntimeOptions } from 'coremind-ai';
import { createEventNotification } from 'coremind-protocol';
import { createPythonToolCallNotification } from 'coremind-protocol';
import { FileRunStore } from 'coremind-ai';
import { ProtocolErrorResponse } from 'coremind-protocol';
import { ProtocolSuccessResponse } from 'coremind-protocol';
import { RunControlCommand } from 'coremind-ai';
import { RunStateRecord } from 'coremind-ai';

declare type ProtocolEventRunStore = FileRunStore & {
    readEventWindow?: (options: {
        runId: string;
        afterSequence: number;
        limit: number;
    }) => Promise<ProtocolEventWindow>;
};

declare interface ProtocolEventWindow {
    retainedFromSequence: number;
    latestSequence: number;
    records: RunStateRecord[];
}

/** 常驻 Node Protocol Host；stdio 只是它的传输适配器。 */
declare class ProtocolHost {
    private readonly options;
    private readonly runtimeFactory;
    private initialized?;
    private selectedProtocol?;
    private readonly toolSpecs;
    private readonly pendingApprovals;
    private readonly pendingToolCalls;
    private readonly protocolV2Starts;
    private activeController?;
    private activeRuntime?;
    private activeRunId?;
    /** 请求预生成的 runId（D-1）：首事件前 cancel 的可寻址值 */
    private requestedRunId?;
    private running;
    private closed;
    private activeExecutionCompletion?;
    private resolveActiveExecution?;
    private lastExecutionQuiescent;
    constructor(options: WorkerServerOptions);
    /** 传输断开只影响交付，不得反向污染 Runtime 或权威 Fact。 */
    private send;
    /** 供 stdio 使用：不等待长运行，以便继续接收 approve/cancel/tool_result。 */
    accept(value: unknown): void;
    handle(value: unknown): Promise<ProtocolSuccessResponse | ProtocolErrorResponse>;
    private handleProtocolV2;
    private beginProtocolV2Run;
    private acceptProtocolV2Control;
    private readProtocolV2Events;
    private queryProtocolV2Projection;
    private waitForActiveRuntime;
    private handleProtocolV2Initialize;
    private dispatch;
    private initialize;
    private registerTool;
    private executeRun;
    private createPythonToolDefinitions;
    private invokePythonTool;
    private resolveToolCall;
    private resolveApproval;
    private applyWorkerControl;
    private inspectRun;
    private checkpointDiff;
    private checkpointRestore;
    private findCheckpoint;
    private cancel;
    private close;
    /** 停止接收新请求，并等待在飞 Runtime/Environment 完成自己的 finally 清理。 */
    shutdown(timeoutMs?: number): Promise<{
        closed: true;
        quiescent: boolean;
    }>;
    private requireInitialized;
}
export { ProtocolHost }
export { ProtocolHost as WorkerServer }

export declare type WorkerMessage = ProtocolSuccessResponse | ProtocolErrorResponse | ReturnType<typeof createEventNotification> | ReturnType<typeof createPythonToolCallNotification>;

export declare type WorkerRuntime = Pick<CoreMindRuntime, "run"> & {
    acceptControl?: (command: RunControlCommand) => Promise<ControlReceipt>;
    applyPendingControls?: () => Promise<ControlReceipt[]>;
};

export declare type WorkerRuntimeFactory = (options: CoreMindRuntimeOptions) => Promise<WorkerRuntime>;

export declare interface WorkerServerOptions {
    send: (message: WorkerMessage) => void;
    runtimeFactory?: WorkerRuntimeFactory;
    runStoreFactory?: (directory: string) => ProtocolEventRunStore;
}

export { }

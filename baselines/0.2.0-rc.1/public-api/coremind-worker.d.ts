import { CoreMindRuntime } from 'coremind-ai';
import { CoreMindRuntimeOptions } from 'coremind-ai';
import { createEventNotification } from 'coremind-protocol';
import { createPythonToolCallNotification } from 'coremind-protocol';
import { ProtocolErrorResponse } from 'coremind-protocol';
import { ProtocolSuccessResponse } from 'coremind-protocol';

export declare type WorkerMessage = ProtocolSuccessResponse | ProtocolErrorResponse | ReturnType<typeof createEventNotification> | ReturnType<typeof createPythonToolCallNotification>;

export declare type WorkerRuntime = Pick<CoreMindRuntime, "run">;

export declare type WorkerRuntimeFactory = (options: CoreMindRuntimeOptions) => Promise<WorkerRuntime>;

/** 常驻 Node worker 的协议状态机；stdio 只是它的传输适配器。 */
export declare class WorkerServer {
    private readonly options;
    private readonly runtimeFactory;
    private initialized?;
    private readonly toolSpecs;
    private readonly pendingApprovals;
    private readonly pendingToolCalls;
    private activeController?;
    private activeRunId?;
    private running;
    private closed;
    constructor(options: WorkerServerOptions);
    /** 供 stdio 使用：不等待长运行，以便继续接收 approve/cancel/tool_result。 */
    accept(value: unknown): void;
    handle(value: unknown): Promise<ProtocolSuccessResponse | ProtocolErrorResponse>;
    private dispatch;
    private initialize;
    private registerTool;
    private executeRun;
    private createPythonToolDefinitions;
    private invokePythonTool;
    private resolveToolCall;
    private resolveApproval;
    private inspectRun;
    private checkpointDiff;
    private checkpointRestore;
    private findCheckpoint;
    private cancel;
    private close;
    private requireInitialized;
}

export declare interface WorkerServerOptions {
    send: (message: WorkerMessage) => void;
    runtimeFactory?: WorkerRuntimeFactory;
}

export { }

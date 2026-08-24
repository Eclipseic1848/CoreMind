import { CoreMindError } from "./errors.js";
import { RunContext } from "./run-context.js";

export interface RunKernelDependency<THarness, TResult> {
  execute(context: RunContext<THarness>): Promise<TResult>;
}

/** 薄执行门面：只拥有 RunContext 生命周期与同实例并发合同。 */
export class RunKernel<THarness, TResult> {
  private active?: Promise<TResult>;
  private latestContext?: RunContext<THarness>;

  constructor(private readonly dependency: RunKernelDependency<THarness, TResult>) {}

  async run(): Promise<TResult> {
    if (this.active) {
      throw new CoreMindError("concurrent_run", "同一 Runtime 实例不支持并发 run()");
    }
    const context = new RunContext<THarness>();
    this.latestContext = context;
    const promise = Promise.resolve().then(() => this.dependency.execute(context));
    this.active = promise;
    try {
      return await promise;
    } finally {
      if (this.active === promise) this.active = undefined;
      context.attachJournal(undefined);
      context.setHarnessFactory(undefined);
    }
  }

  currentContext(): RunContext<THarness> | undefined {
    return this.latestContext;
  }
}

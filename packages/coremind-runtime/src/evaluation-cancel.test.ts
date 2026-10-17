import type { CoreMindConfig } from "coremind-config";
import { expect, it, vi } from "vitest";
import { CoreMindError } from "./errors.js";
import { type EvaluationRuntimeFactory, runEvaluationSuite } from "./evaluation.js";
import type { RunResult } from "./runtime.js";

const config: CoreMindConfig = {
  schemaVersion: 2,
  name: "evaluation-cancel",
  agents: { main: {} },
  quality: { profile: "development" },
};
const suite = {
  schemaVersion: 1 as const,
  scenarios: [
    { id: "first", input: "first", expected: {}, repetitions: 3 },
    { id: "next", input: "next", expected: {}, repetitions: 3 },
  ],
};

it("评测开始前已取消，不创建任何 Runtime", async () => {
  const controller = new AbortController();
  controller.abort();
  const factory = vi.fn<EvaluationRuntimeFactory>();
  await expect(
    runEvaluationSuite({
      config,
      configDir: ".",
      suite,
      signal: controller.signal,
      runtimeFactory: factory,
    }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(factory).not.toHaveBeenCalled();
});

it("加载确认中断停止本次及后续场景，不写成拒绝的评测结果", async () => {
  const controller = new AbortController();
  const factory = vi.fn<EvaluationRuntimeFactory>(async (options) => {
    expect(options.signal).toBe(controller.signal);
    controller.abort();
    throw new CoreMindError("aborted", "项目代码加载已取消");
  });
  await expect(
    runEvaluationSuite({
      config,
      configDir: ".",
      suite,
      signal: controller.signal,
      runtimeFactory: factory,
    }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(factory).toHaveBeenCalledOnce();
});

it("运行的取消收尾返回后停止后续场景，不消费不完整结果", async () => {
  const controller = new AbortController();
  let finish!: () => void;
  const factory = vi.fn<EvaluationRuntimeFactory>(async (options) => {
    expect(options.signal).toBe(controller.signal);
    return {
      run: () =>
        new Promise<RunResult>((resolve) => {
          controller.abort();
          finish = () =>
            resolve({ outcome: { status: "aborted", finishReason: "aborted" } } as RunResult);
        }),
    };
  });
  let completed = false;
  const running = runEvaluationSuite({
    config,
    configDir: ".",
    suite,
    signal: controller.signal,
    runtimeFactory: factory,
  });
  const rejected = expect(running).rejects.toMatchObject({ code: "aborted" });
  void running.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(completed).toBe(false);
  finish();
  await rejected;
  expect(factory).toHaveBeenCalledOnce();
});

it("明确拒绝仍保持安全错误并按既有评测规则处理，不伪造成取消", async () => {
  const controller = new AbortController();
  const factory = vi.fn<EvaluationRuntimeFactory>(async () => {
    throw new CoreMindError("execution_security_violation", "宿主明确拒绝加载");
  });
  const result = await runEvaluationSuite({
    config,
    configDir: ".",
    suite,
    signal: controller.signal,
    runtimeFactory: factory,
  });
  expect(controller.signal.aborted).toBe(false);
  expect(factory).toHaveBeenCalledTimes(6);
  expect(result.attempts).toHaveLength(6);
  for (const attempt of result.attempts) {
    expect(attempt.outcome.error?.code).toBe("execution_security_violation");
    expect(attempt.outcome.finishReason).not.toBe("aborted");
  }
});

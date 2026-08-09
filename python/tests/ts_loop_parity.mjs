import { CoreMindRuntime } from "coremind-ai";

const [baseUrl, configDir] = process.argv.slice(2);
const config = {
  schemaVersion: 2,
  name: "Loop 跨语言一致性测试",
  provider: { id: "probe", baseUrl, model: "probe-model", apiKey: "test-key" },
  agents: {
    coder: { systemPrompt: "编码" },
    reviewer: { systemPrompt: "验证" },
  },
  loop: {
    execute: { agent: "coder", input: "执行 {{prompt}}" },
    verify: {
      agent: "reviewer",
      input: "验证 {{candidate.text}}",
      passIf: "{{text}} == PASS",
    },
    repair: { agent: "coder", input: "根据 {{verification.text}} 修复" },
    maxIterations: 3,
    maxRepairs: 2,
    maxRepeatedAction: 3,
  },
};
const runtime = await CoreMindRuntime.create({
  config,
  configDir,
  cwd: configDir,
  initialPrompt: "修复缺陷",
});
const result = await runtime.run();
process.stdout.write(
  `${JSON.stringify({
    ...result,
    outputs: Object.fromEntries(result.outputs),
    messages: Object.fromEntries(result.messages),
  })}\n`,
);

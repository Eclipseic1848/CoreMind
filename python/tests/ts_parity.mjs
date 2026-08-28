import { CoreMindRuntime } from "coremind-ai";

const [baseUrl, configDir, input] = process.argv.slice(2);
const config = {
  schemaVersion: 2,
  name: "跨语言一致性测试",
  provider: {
    id: "probe",
    baseUrl,
    model: "probe-model",
    apiKeyEnv: "COREMIND_TEST_API_KEY",
  },
  agents: { main: { systemPrompt: "测试助手" } },
};
const runtime = await CoreMindRuntime.create({
  config,
  configDir,
  cwd: configDir,
  initialPrompt: input,
});
const result = await runtime.run();
process.stdout.write(
  `${JSON.stringify({
    ...result,
    outputs: Object.fromEntries(result.outputs),
    messages: Object.fromEntries(result.messages),
  })}\n`,
);

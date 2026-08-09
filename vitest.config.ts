import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4 使用 projects；所有包与黄金示例必须共用 npm test 门禁。
    // 外层上限必须覆盖产品自身最长 10 秒的受控进程超时，避免高负载 Runner 先误判失败。
    testTimeout: 15_000,
    projects: [
      "packages/*",
      "examples/golden/vitest.config.ts",
      "examples/coding-evals/vitest.config.ts",
      "scripts/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.*", "**/dist/**"],
      reporter: ["text", "json-summary"],
      reportOnFailure: true,
    },
  },
});

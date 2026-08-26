import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4 使用 projects；所有包与黄金示例必须共用 npm test 门禁。
    // 项目模式不会把这里的上限可靠地下传到每个独立项目；长链路项目必须在自身配置中显式声明。
    testTimeout: 15_000,
    projects: [
      "packages/*",
      "packages/coremind-runtime/vitest.input-receipt-acceptance.config.ts",
      "packages/coremind-tools/vitest.host-shell.config.ts",
      "examples/golden/vitest.config.ts",
      "examples/coding-evals/vitest.config.ts",
      "scripts/vitest.config.ts",
      "scripts/vitest.trusted-tool-fault-matrix.config.ts",
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

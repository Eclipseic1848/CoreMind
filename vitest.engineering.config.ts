import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 工程门覆盖确定性与关键双平台项目；候选门通过根配置补充重型故障与基线项目。
    testTimeout: 15_000,
    projects: [
      "packages/*",
      "packages/coremind-runtime/vitest.input-receipt-engineering.config.ts",
      "packages/coremind-tools/vitest.host-shell.config.ts",
      "examples/golden/vitest.config.ts",
      "examples/coding-evals/vitest.config.ts",
      "scripts/vitest.config.ts",
    ],
  },
});

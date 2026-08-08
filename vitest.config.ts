import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4 使用 projects；所有包与黄金示例必须共用 npm test 门禁。
    projects: ["packages/*", "examples/golden/vitest.config.ts", "scripts/vitest.config.ts"],
  },
});

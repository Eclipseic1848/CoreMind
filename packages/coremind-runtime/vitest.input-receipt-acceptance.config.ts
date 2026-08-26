import { defineProject } from "vitest/config";

export default defineProject({
  root: import.meta.dirname,
  test: {
    name: "coremind-runtime-input-receipt-acceptance",
    include: ["src/input-receipt.acceptance.test.ts"],
    fileParallelism: false,
    // 时延验收在普通项目与资源故障矩阵之后独立运行，避免并行调度污染 p95。
    sequence: { groupOrder: 3 },
    testTimeout: 90_000,
  },
});

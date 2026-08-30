import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "isolated-trusted-tool-fault-matrix",
    include: ["trusted-tool-fault-matrix.test.ts"],
    fileParallelism: false,
    sequence: { groupOrder: 2 },
    // 1,950 个真实边界场景在 Windows CI 上超过 15 分钟；该验收预算不改变产品超时。
    testTimeout: 1_200_000,
  },
});

import { defineProject } from "vitest/config";

export default defineProject({
  root: import.meta.dirname,
  test: {
    name: "isolated-input-receipt-acceptance",
    include: ["src/input-receipt.acceptance.test.ts"],
    fileParallelism: false,
    // 完整 npm test 中作为独立资源组；test:stability 会另起进程先运行本项目。
    sequence: { groupOrder: 3 },
    testTimeout: 90_000,
  },
});

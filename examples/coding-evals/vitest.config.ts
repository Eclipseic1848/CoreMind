import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "coding-evals",
    include: ["coding-evals.test.ts"],
    // 评测会反复启动测试子进程；等普通单元/属性项目结束后再验收。
    sequence: { groupOrder: 1 },
    // 每个用例包含缺陷复现、Runtime 工具链和两轮测试子进程。
    testTimeout: 30_000,
  },
});

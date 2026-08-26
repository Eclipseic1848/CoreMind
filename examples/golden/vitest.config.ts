import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "golden-examples",
    include: ["**/*.test.ts"],
    // 示例会启动真实 Runtime 与本地 Provider；等普通单元/属性项目结束后再验收。
    sequence: { groupOrder: 1 },
  },
});

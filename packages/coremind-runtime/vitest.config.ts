import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "coremind-runtime",
    exclude: ["src/input-receipt.acceptance.test.ts"],
    // 评测与宿主 Shell 用例会启动真实子进程；上限需覆盖产品最长 10 秒的受控进程超时。
    testTimeout: 15_000,
  },
});

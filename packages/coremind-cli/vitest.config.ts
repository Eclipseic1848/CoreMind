import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "coremind-cli",
    // E2E 用例会启动真实 Node 子进程；并发全量测试下 5 秒不足以区分慢启动与卡死。
    testTimeout: 30_000,
  },
});

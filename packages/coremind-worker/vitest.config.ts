import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "coremind-worker",
    // 真实文件持久化、Host 恢复与 Checkpoint 验收在 Windows CI 上会超过默认 5 秒。
    testTimeout: 30_000,
  },
});

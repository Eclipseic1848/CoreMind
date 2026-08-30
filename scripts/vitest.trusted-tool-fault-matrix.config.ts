import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "isolated-trusted-tool-fault-matrix",
    include: ["trusted-tool-fault-matrix.test.ts"],
    fileParallelism: false,
    sequence: { groupOrder: 2 },
    testTimeout: 900_000,
  },
});

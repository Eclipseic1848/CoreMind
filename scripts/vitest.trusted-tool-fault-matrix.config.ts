import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "trusted-tool-fault-matrix",
    include: ["trusted-tool-fault-matrix.test.ts"],
    fileParallelism: false,
    sequence: { groupOrder: 1 },
    testTimeout: 900_000,
  },
});

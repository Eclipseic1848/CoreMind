import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "release-engineering",
    include: ["**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "phase2-baseline.test.ts",
      "trusted-tool-fault-matrix.test.ts",
    ],
  },
});

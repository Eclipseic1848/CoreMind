import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "golden-examples",
    include: ["**/*.test.ts"],
  },
});

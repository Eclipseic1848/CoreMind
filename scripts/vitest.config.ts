import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "release-engineering",
    include: ["**/*.test.ts"],
  },
});

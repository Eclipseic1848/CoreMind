import { expect, it } from "vitest";
import { type ToolApprovalRequest, ToolPolicy } from "./tool-policy.js";

it("authorize 保留原六参和 args，只有末尾显式身份才增加字段", async () => {
  const requests: ToolApprovalRequest[] = [];
  const args = Object.freeze({ path: "README.md" });
  const policy = new ToolPolicy({
    cwd: process.cwd(),
    runId: "approval-policy",
    permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
    createApprovalId: () => `approval-${requests.length}`,
    approve: async (request) => {
      requests.push(request);
      return "allow";
    },
  });
  expect(
    (await policy.authorize("main", "read", args, undefined, undefined, undefined)).allowed,
  ).toBe(true);
  expect(
    (
      await policy.authorize("main", "read", args, undefined, undefined, undefined, {
        callId: "call-exact",
        stepId: "step-exact",
      })
    ).allowed,
  ).toBe(true);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.args).toBe(args);
  expect(requests[1]!.args).toBe(args);
  expect(requests[0]!.argumentsFingerprint).toBe(requests[1]!.argumentsFingerprint);
  for (const field of ["callId", "stepId"]) expect(Object.hasOwn(requests[0]!, field)).toBe(false);
  expect(requests[1]).toMatchObject({
    callId: "call-exact",
    stepId: "step-exact",
    agent: "main",
    tool: "read",
  });
});

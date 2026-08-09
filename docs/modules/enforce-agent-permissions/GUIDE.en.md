# Permissions and Security Guide

## When to use it

Enforce ask, assisted, and full approval modes while distinguishing path-aware file tools, the Linux bash OS sandbox, and Windows shell risk boundaries.

## Minimal example

```text
permissions:
  mode: assisted
  workspaceOnly: true
  network: deny
  deny:
    - bash
```

The three modes decide who approves; they never override explicit policy:

| Scenario | ask | assisted | full |
|---|---|---|---|
| Declared low-risk read/write inside the workspace | Prompt | Auto-approve | Auto-approve |
| Network policy is `ask` | Prompt | Prompt | Prompt |
| Explicit deny or escaped path | Deny | Deny | Deny |
| Windows shell with workspace restriction or network not allowed | Deny | Deny | Deny |
| Windows shell with open workspace and allowed network | Deny | Deny | Execute without OS isolation |
| Undeclared custom effect while restrictions apply | Deny | Deny | Deny |

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/enforce-agent-permissions/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. On Windows, verify file tools still work and that `bash` is denied in ask, assisted, or whenever one restriction remains. With all three conditions open, confirm a real Git Bash or PowerShell is selected and trace, checkpoints, and audit remain active.
6. Verify that `..`, outside absolute paths, another drive, UNC paths, and directory links pointing outside the workspace are all denied.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.

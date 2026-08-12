# Permissions and Security Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
permissions:
  mode: assisted
  workspaceOnly: true
  network: deny
  deny:
    - bash
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. On Windows, request `bash`. Ask, assisted, `workspaceOnly: true`, or a network policy other than `allow` must each deny execution. Only full mode with open workspace access and allowed network executes, and Git Bash or PowerShell must not be described as an isolation layer.
6. Request a long-body write and confirm the approval panel still shows the complete target, effect, and reason.
7. Try `..`, an outside absolute path, another drive, UNC, and a directory link pointing outside the workspace; confirm every case is denied before execution.
8. In ask mode, deny the first write approval. Confirm that the same run does not request another tool approval, the file does not exist, and the outcome is `paused`.

Return to the [English guide](../../../docs/modules/enforce-agent-permissions/GUIDE.en.md).

# Configuration and Schema Example

## Run the Runtime alone

Follow the [2.2.0 installation guide](../../../docs/en/guide/01-quickstart.md) for the CLI and any SDK you use. In your application directory, run `npx --no-install coremind create . --runtime-only --provider deepseek --model deepseek-flash` and set the credential for your chosen model. You can also copy the [minimal configuration](../../../docs/en/guide/06-capability-construction.md).

- CLI: `coremind run coremind.yaml --prompt "Reply only OK"`.
- TypeScript: run `npm install --save-exact coremind-ai@2.2.0`, copy [runtime-only.mts](runtime-only.mts) to the project root, and run `node runtime-only.mts`.
- Python: run `python -m pip install coremind-ai==2.2.0` and copy [runtime_only.py](runtime_only.py) to the root. Run `python runtime_only.py` and `python runtime_only.py --async` for the two Python entry points.

All four entry points should produce a reply in one turn. Check that the model request has an empty tool catalog and that the application needs only its base configuration and Runtime dependencies.

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
schemaVersion: 2
name: support-agent
agents:
  main:
    systemPrompt: 你是客服助手
permissions:
  mode: ask
  workspaceOnly: true
  network: ask
runtime:
  maxTurns: 12
quality:
  profile: standard
```

When adding a custom script tool, declare its effects with this structure:

```yaml
agents:
  main:
    tools:
      - path: tools/save-report.mjs
        effect:
          operations: [write]
          reversible: true
          pathFields: [output.path]
```

Published `0.8.0` Loops also support `verify.mode: host`: the host submits a durable decision and does not configure `passIf`. See the [host verification example](../../host-verification/README.en.md) for configuration and an offline demo.

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.

Return to the [English guide](../../../docs/modules/configure-coremind/GUIDE.en.md).

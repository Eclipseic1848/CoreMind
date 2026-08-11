# Runtime Dependency Adapter Guide

## For application developers

Application developers do not configure adapters. After installation or upgrade, run:

```powershell
coremind doctor .\coremind.yaml
```

A passing “Runtime compatibility layer” check means the release-recognized dependency family, capabilities, and error mapping loaded successfully. It is not live-provider certification.

## For maintainers

```powershell
npm ci --ignore-scripts
npm run build
npm run dependencies:check
npm run baseline:check
```

Then run the Provider, tool, Session, usage, error, and timeout tests listed in the module manifest. Linux sandbox installation and real isolation tests must run in the Linux gate; Windows results cannot replace them.

## Upgrade rules

1. Align every critical package in an isolated candidate. Never evaluate a mixed family as the main path.
2. Run contract tests before removing compatibility casts.
3. Catalog growth changes configurability only; certification evidence does not automatically transfer to new providers or versions.
4. Candidate-baseline updates require migration, compatibility, and rollback reasons. The reference baseline stays immutable.
5. Roll back the complete family when Session, message, or tool protocols cannot be adapted losslessly.

## Common mistakes

- A passing doctor check does not validate an API key or send a real model request.
- A larger Provider catalog does not certify new entries.
- Do not join two tool-type versions through double casts.
- Do not ship an SDK shrinkwrap that overrides application dependency resolution.

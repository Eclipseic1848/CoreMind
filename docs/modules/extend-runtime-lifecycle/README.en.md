# Runtime Lifecycle Extensions

Status: published with stable `0.7.0`. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

This module lets a host export trace data or add a denial policy without changing Runtime internals. The first version deliberately exposes only four read-only events. It does not scan project directories, provide a marketplace, expose arbitrary internal objects, or let extensions approve tools.

| Event | Timing | Intended use |
|---|---|---|
| `before-model` | Before context protection and a model request | Read-only audit and metrics |
| `before-tool` | After shared permission allows, before checkpoint capture | Read-only audit or an additional denial |
| `after-tool` | After tool, artifact, checkpoint, and budget evidence | Result export and metrics |
| `run-finished` | After the operation enters its truthful terminal state | Terminal export and alerts |

## Public interfaces

- `defineLifecycleExtension()` validates ids, versions, capabilities, and handlers.
- `LifecycleExtensionHost` runs explicitly trusted extensions in stable id order.
- `createTraceExporterExtension()` is a read-only four-event exporter.
- `createDenyPolicyExtension()` adds a `before-tool` denial.
- `CoreMindRuntimeOptions.lifecycleExtensions` supplies registration, trust, grants, and timeout.
- `RunResult.extensions` and `extension_lifecycle` preserve execution receipts.

## Trust and threat model

Extension code runs in the host process, so explicit registration is itself a code-trust decision. Capability declarations are admission and audit controls, not an operating-system sandbox. Put integrations that need strong isolation in a separate controlled process and connect them through a stable tool or protocol.

CoreMind enforces these invariants:

- An id absent from `trustedIds` cannot load.
- File, process, network, credential, and UI requests must be fully covered by `grants`.
- Without credential capability, keys, authorization headers, cookies, private keys, URL credentials or sensitive query parameters, and command secrets are recursively redacted. Business body fields remain available under the declared capability contract.
- Handlers receive a deeply frozen clone and cannot mutate Runtime objects.
- Timeouts and failures produce receipts but never escape into the Runtime.
- `before-tool` may only add a denial; it cannot override shared or human denial.
- `run-finished` observes an already decided operation and outcome, so it cannot forge success.

## Explicit boundary

This is not a security sandbox, plugin store, automatic project trust system, or second Runtime. CoreMind never auto-loads unknown workspace code or exposes provider-private objects. Follow the [SOP](SOP.en.md) and [example](../../../examples/modules/extend-runtime-lifecycle/README.en.md) before publishing an extension.

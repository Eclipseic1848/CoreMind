# Tools and Business Capabilities Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Define the input JSON Schema, `effect.operations`, `effect.reversible`, and idempotency strategy. Use `external` and `false` when uncertain.
2. Implement deterministic code instead of hiding rules in prompts.
3. Cover success, invalid input, dependency failure, and repeated calls.
4. Declare non-standard path or URL fields with `pathFields` or `urlFields`, confirm permission and real recovery behavior for writes, and reject names that collide with built-in tools.
5. Use command and argument arrays for subprocesses, with timeout, output limit, cancellation signal, and a minimal environment. Treat an explicit `env` as authoritative; never merge host secrets into it or let the tool execution context replace it.
6. Use only fixed `GitAdapter` reads for Git evidence. Stop and request separate authorization before mutating Git state.
7. Bound file input, output, and complexity before diff calculation, and reject paths outside the workspace or through escaping links.
8. Verify in Linux CI that bash cannot write outside the workspace or access the network; keep execution sequential so shared sandbox cleanup cannot race.
9. Verify on Windows that constrained modes reject the host shell and that execution requires all three explicitly open conditions. Cover Git Bash, the PowerShell fallback, and an explicit minimal environment.
10. Run the listed module tests and `npm run check:modules`.
11. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Additional acceptance for local MCP

Confirm the program, directory, arguments, and environment references using the [configuration guide](../../en/guide/02-configuration.md#agent-scoped-local-mcp-tools). Run static diagnostics with zero startup, then verify denial and approval independently for connection, listing, and business execution. Check full schema, approval identity, blocked secrets, unknown effects, and actual process cleanup. Preserve the constrained-project quality gate without a trusted-host exemption.

Maintainers rebuild the fixed Job assembly or host with `node scripts/build-windows-mcp-service.mjs --rebuild-guard` or `node scripts/build-windows-mcp-service.mjs --rebuild-host`, respectively, in a controlled Windows environment, then review the corresponding C# source, Framework csc/three reference digests, and generated DLL/EXE. Changed source requires recompiling the corresponding asset, not a rewritten receipt. If both sources change, pass `--rebuild-guard --rebuild-host` explicitly together. Normal builds, `--check`, `--copy-only`, and `--python-assets` only verify and copy frozen assets; Linux needs no compiler. Retain the original Windows Job/MCP regressions, 15-second/60-second gates, and npm/wheel/source-ZIP installation checks, including pre-cancellation, owner death, all-descendant shutdown, and unknown-cleanup failures. Provenance does not promise byte-deterministic output across compilers or replace real platform acceptance.

## Additional acceptance for controlled HTTP MCP

1. Fix the URL and Header references using the [HTTP configuration](../../en/guide/02-configuration.md#controlled-http-mcp-and-exact-resource-authorization). Authentication environment variables contain complete Header values. Missing credentials and 401/403 must not change identity, start OAuth, or refresh tokens.
2. Cover default public HTTPS, a nonempty `allowedAddresses` set constraining every address, explicit loopback HTTP, rejected addresses, and DNS-to-socket pinning. Redirects and environment proxies must not carry credentials elsewhere; static diagnostics must not connect.
3. Verify configuration approval with `network: allow`, the existing approval with `network: ask`, and zero sends under deny. Preserve truthful business effects/capabilities, workspace gates, budgets, critical barriers, and receipts in the same Harness.
4. Authorize exact original URIs per agent. Cover missing/empty sets with no inheritance, HTTP-only resources, list/templates/read, pagination, guessed URIs, and unauthorized response URIs. Resource-only startup sends no HTTP before the first model request; tool-only selection sends no resource requests. Never dereference host files or links or accept blobs.
5. Inject cancellation, disconnects, 401/403/408/429/5xx, invalid bodies, and limits after a real request has entered. Cover 8 MiB bodies, 64 MiB owners, 32 pages/256 entries, 30-second total deadlines, and at most three GETs per owner in 30 seconds. Cancelling one request must preserve other authorized calls; a write followed by a lost response must not resend its business POST.
6. Check model requests, Facts/query/events, Artifacts, CLI, and Worker JSON for credential leakage. Verify local bodies/sockets/the dispatcher have settled before fixture cleanup. Remote sessions rely on service leases; no DELETE is sent.
7. Run the listed TypeScript, CLI, Python sync/async, and old-Worker rejection regressions while retaining stdio tests. Record workspace, installed-artifact, platform, and real external interoperability evidence separately; do not mark unexecuted forms as passed.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.

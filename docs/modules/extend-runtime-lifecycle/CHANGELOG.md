# Changelog

## 0.3.1 - 2026-08-21

- Applied shared recursive credential redaction to lifecycle payloads, including cookies, private keys, URLs, and command arguments.

## 0.3.0 - 2026-08-13

- Applied shared recursive credential redaction to lifecycle payloads, including cookies, private keys, URLs, and command arguments.

## 0.3.0-rc.2 - 2026-08-12

- Applied shared recursive credential redaction to lifecycle payloads, including cookies, private keys, URLs, and command arguments.

## 0.3.0-rc.1 - 2026-08-12

- Synchronized this module contract with the repository release candidate.
- Added no module-specific product behavior during the Batch 6 release-candidate closure.

## 0.3.0-beta.2

- Added four read-only Runtime lifecycle events.
- Added explicit trust, per-capability grants, timeouts, redacted payloads, and execution receipts.
- Added trace-exporter and additive deny-policy helpers.
- Added tests proving extensions cannot bypass approvals, checkpoints, or truthful terminal states.

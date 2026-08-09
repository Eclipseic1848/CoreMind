---
name: build-verified-repair-loop
description: "Run, diagnose, and safely adapt the offline Verified Repair Loop golden example. Use for this example's configuration, implementation, evaluation, or documented failure cases."
---

# Verified Repair Loop

1. Read ../../README.en.md and ../../SOP.en.md.
2. Start the local loop mock provider on port 8815; never substitute a real endpoint silently.
3. Execute repair success, pause-resume, and exhaustion paths; do not accept a candidate before verification passes.
4. Preserve ordered Loop states, RunOutcome, Trace, and effect-receipt evidence, then run the example evaluation.
5. Ask the business owner before changing data fields, verification rules, thresholds, permissions, or external access.

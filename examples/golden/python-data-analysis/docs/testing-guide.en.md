# Testing Guide

1. `coremind check coremind.yaml`。
2. Run the offline happy path。
3. Run at least one failure from FAILURES。
4. `python -m unittest discover -s tests -p "test_*.py"`。
5. Verify exit code, RunOutcome, tool counts, approvals, trace, and checkpoints。

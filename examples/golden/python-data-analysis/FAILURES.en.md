# Failure Cases and Repairs

1. Worker not found: run npm run build:python-worker at the repository root.
2. coremind import fails: install the wheel or set PYTHONPATH=../../../python/src.
3. Path traversal is rejected by the Python tool by design.

After repair, rerun the same failing scenario and compare before-and-after traces rather than only final text.

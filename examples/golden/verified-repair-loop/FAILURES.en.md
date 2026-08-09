# Failure Cases and Repairs

1. A failed verification is not success: it must transition to repair, pause, or fail.
2. Resume the same runId after pause without replaying a completed execute step.
3. Exhausting maxRepairs must return loop_exhausted instead of accepting an unverified result.

After repair, rerun the same failing scenario and compare before-and-after traces rather than only final text.

# Failure Cases and Repairs

1. Output is not JSON: parseContractReview must reject instead of guessing.
2. A step is missing: ensure maxSteps is at least 3.
3. The example does not replace legal counsel or the business owner.

After repair, rerun the same failing scenario and compare before-and-after traces rather than only final text.

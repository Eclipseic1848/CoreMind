# Failure Cases and Repairs

1. Mock provider is not running: start it and check port 8811.
2. Review src/order-tool.ts and its imports before using --trust-project-code; ask still denies tools in non-TTY mode, so only trusted offline CI may separately add --permission full, which does not approve code loading.
3. A-999 returning not found is the expected business failure branch; do not fabricate an order.

After repair, rerun the same failing scenario and compare before-and-after traces rather than only final text.

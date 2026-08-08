# 测试指南

1. `coremind check coremind.yaml`。
2. 运行离线正常场景。
3. 运行 FAILURES 中的至少一个失败场景。
4. `python -m unittest discover -s tests -p "test_*.py"`。
5. 确认退出码、RunOutcome、工具计数、审批、Trace 与 checkpoint 符合预期。

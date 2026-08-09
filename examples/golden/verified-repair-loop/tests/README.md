# 验证修复 Loop 测试 / Verified Repair Loop Tests

`examples/golden/golden-examples.test.ts` 使用真实 CoreMind Runtime 与本地 mock Provider 验证：

- 首次验证失败后进入 repair，并在再次验证通过后才成功；
- 暂停后从同一 runId 恢复，不重复已经完成的 execute；
- `maxRepairs` 耗尽后返回 `loop_exhausted`，不接受未验证候选结果。

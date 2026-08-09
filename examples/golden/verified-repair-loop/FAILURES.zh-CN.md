# 失败案例与修复

1. 验证失败不是运行成功：必须进入 repair、pause 或 fail。
2. 暂停后使用同一 runId 恢复，不得重复已经完成的 execute。
3. maxRepairs 耗尽必须返回 loop_exhausted，不能接受未通过结果。

修复后重新运行对应失败场景，并比较修复前后 Trace；不要只看最终回答。

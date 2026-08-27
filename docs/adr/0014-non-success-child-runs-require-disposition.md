# 非成功 Child Run 必须由父级明确处置

`parent_joined` 只证明父 Run 收到了 ChildRunResult，不证明风险已经处理；成功结果可在 join 后默认接受，普通失败、主动取消、超时或预算耗尽必须先记录 Delegation Disposition，父级才能继续或结束。orphan、未知 Effect、未静止或执行所有权不明会强制父 Run 暂停，因为允许模型忽略这些状态会使父级在仍有未知活动或副作用时错误宣称成功。

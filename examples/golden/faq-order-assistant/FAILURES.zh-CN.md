# 失败案例与修复

1. 未启动 mock Provider：先运行启动命令并检查 8811 端口.
2. 先审查 src/order-tool.ts 及其依赖，再用 --trust-project-code 批准加载；非 TTY 下 ask 仍拒绝工具，仅可信离线 CI 才另加 --permission full，full 不替代加载批准.
3. A-999 返回未找到是预期业务失败分支，不应改成虚构订单.

修复后重新运行对应失败场景，并比较修复前后 Trace；不要只看最终回答。

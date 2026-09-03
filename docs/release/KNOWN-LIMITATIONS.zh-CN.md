# 0.7.0 稳定候选已知限制

> 本文件描述已创建 Tag、尚未公开发布的 `0.7.0` 候选能力边界；当前公开稳定版仍是 `0.3.1`，安装可用性以 Release 与 Registry 为准。

- 当前 40 个 Provider 均可配置，但 `0.7.0` 没有真实父子 Agent 成功认证。严格运行 `33582995518` 的首个 Provider 请求在 HTTP 响应前超时；维护者将其作为仅限本版本的网络例外通过。该裁决不是 live-provider 成功，`0.3.2` 及更早证据也只供追溯。
- 二期真实外部同题模型评测尚未执行，离线 Coding Eval 不能替代真实模型质量结论。
- `0.7.0` 的候选包、双平台 TTY、Runtime 摘要、网络例外与公开发布证据必须精确关联；任何局部检查通过都不等于公开发布。
- 全仓覆盖率不下降门禁通过，但总体 lines/statements/branches 仍低于长期 80% 目标；部分关键安全分支仍低于 90%。
- 生命周期扩展是进程内受控扩展，不是操作系统沙箱。只开放四个事件，默认不加载未知项目扩展。
- Windows 宿主 Shell 的安全边界依赖权限、工作区和网络组合；Linux 内置 Shell 才使用额外的断网隔离。两者不应被描述为相同级别的沙箱。
- Python SDK 使用随包 Node Worker，因此仍要求 Node.js `>=22.19`；不存在独立纯 Python Runtime。
- Checkpoint 与 Effect Receipt 提供恢复和幂等关联证据，但不保证外部业务系统“恰好一次”。结果不确定时必须暂停并人工核验。
- 默认压缩是本地确定性策略，不自动创建项目 Memory；实验策略不会自动切换为默认。
- Child Run 不支持 durable detach、独立 spawn/list/resume 命令、Goals 或 Jobs；本期不包含 Web。
- 当前不提供官方托管 API、多租户 SaaS、官方 Docker 镜像、macOS 正式支持或扩展市场。
- `v0.7.0` Tag 已创建，但 GitHub Release、npm 与 PyPI 尚未发布；这些公开渠道是安装可用性的最终依据。

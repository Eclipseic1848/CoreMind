# 0.8.0 已知限制

> 本文件描述 `0.8.0` 发布线的能力边界；GitHub Release、npm 与 PyPI 实时页面是安装可用性的唯一依据。

- 40个Provider可配置，但不等于真实认证。0.8.0须使用绑定本次候选版本、提交与Runtime摘要的strict-provider证据；旧版本认证和发布豁免不能替代。
- 二期真实外部同题模型评测尚未执行，离线 Coding Eval 不能替代真实模型质量结论。
- 全仓覆盖率不下降门禁通过，但总体 lines/statements/branches 仍低于长期 80% 目标；部分关键安全分支仍低于 90%。
- 生命周期扩展是进程内受控扩展，不是操作系统沙箱。只开放四个事件，默认不加载未知项目扩展。
- Windows 宿主 Shell 的安全边界依赖权限、工作区和网络组合；Linux 内置 Shell 才使用额外的断网隔离。两者不应被描述为相同级别的沙箱。
- Python SDK 使用随包 Node Worker，因此仍要求 Node.js `>=22.19`；不存在独立纯 Python Runtime。
- Checkpoint 与 Effect Receipt 提供恢复和幂等关联证据，但不保证外部业务系统“恰好一次”。结果不确定时必须暂停并人工核验。
- 默认压缩是本地确定性策略，不自动创建项目 Memory；实验策略不会自动切换为默认。
- Child Run 不支持 durable detach、独立 spawn/list/resume 命令、Goals 或 Jobs；本期不包含 Web。
- 当前不提供官方托管 API、多租户 SaaS、官方 Docker 镜像、macOS 正式支持或扩展市场。
- `v0.8.0` Tag、GitHub Release、8 个 npm 包与 PyPI 必须版本一致；包的构建提交与源码 ZIP 的发布提交分别记录在清单中，二者之间不得有产品代码变更。公开渠道是安装可用性的最终依据。

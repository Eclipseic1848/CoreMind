# 1.1.0 已知限制

> 本文件描述 `1.1.0` 发布线的能力边界；公开可安装状态以 GitHub Release、npm、PyPI 实时页面与同提交资格证据为准，源码 CI 通过不等于发布。

- 40个Provider可配置，但不等于真实认证。1.1.0须使用绑定本次候选版本、最终提交与Runtime摘要的strict-provider证据；旧版本认证和发布豁免不能替代。
- 二期真实外部同题模型评测尚未执行，离线 Coding Eval 不能替代真实模型质量结论。
- 发布要求全仓覆盖率不下降；`1.0.1` 记录的总体 lines/statements/branches 低于长期 80% 目标，部分关键安全分支低于 90%。`1.1.0` 的实际值以同提交覆盖率报告为准，不用旧数值代替本轮结果。
- 生命周期扩展是进程内受控扩展，不是操作系统沙箱。只开放四个事件，默认不加载未知项目扩展。
- Windows 宿主 Shell 的安全边界依赖权限、工作区和网络组合；Linux 内置 Shell 才使用额外的断网隔离。两者不应被描述为相同级别的沙箱。
- Python SDK 使用随包 Node Worker，要求 Python `>=3.10` 与 Node.js `>=22.19`；不存在独立纯 Python Runtime。新能力需要匹配的 SDK/Worker；Protocol v2 的 Schema 指纹必须一致，旧 Worker 忽略字段不能视为支持。
- Checkpoint 与 Effect Receipt 提供恢复和幂等关联证据，但不保证外部业务系统“恰好一次”。结果不确定时必须暂停并人工核验。
- 默认压缩是本地确定性策略，不自动创建项目 Memory；实验策略不会自动切换为默认。
- Child Run 不支持 durable detach、独立 spawn/list/resume 命令、Goals 或 Jobs；本期不包含 Web。
- 当前不提供官方托管 API、多租户 SaaS、官方 Docker 镜像、macOS 正式支持或扩展市场。
- `v1.1.0` Tag、GitHub Release、8 个 npm 包与 PyPI 必须版本一致；包的构建提交与源码 ZIP 的发布提交分别记录在清单中，二者之间不得有产品代码变更。公开渠道是安装可用性的最终依据。

- Trace 无空白片段可能延迟到轮次结束；未闭合安全缓冲上限为 65,536 字符。凭据步骤候选明确失败，不静默修改验收哈希。
- v1 Python 工具取消只结束本地等待，外部函数未确认收尾时不能视为 quiescent；Linux Web 的宿主网络域不继承 Shell 沙箱隔离。

## 1.1.0 扩展与交互边界

- 标准 Skill 只加载显式选择的本地 `SKILL.md`，正文在 Runtime 创建时冻结；旧内置/README 技能保持原路径。不自动扫描远程技能、运行脚本或授予新权限。
- 持久 `/steer`、`/follow-up` 不新建并发 Run，也不改 Provider、权限或预算；`accepted/applied/rejected/duplicate/conflict` 回执不等于实际输入已被模型认领或完成。
- 本地 MCP stdio 是当前账户权限下的受信宿主进程；白名单或 roots 不是操作系统沙箱。取消后的未知外部效果仍须人工核对，不自动重放。
- HTTP MCP 只访问固定目标、精确授权资源 URI 与受控凭据；不提供任意宿主路径读取或二进制资源回退。Child Run 不继承 MCP 服务、资源或凭据授权。
- OAuth 仅由宿主显式发起，用户自行打开授权链接，支持取消与登出；loopback 回调必须可达。不支持的认证模式不会自动降级，业务 401/403 不会隐式触发登录。实际外部授权服务器/MCP 服务互通尚未认证。
- Config v2、默认/显式 `direct` 与 Protocol v1 继续兼容；`deferred` 必须显式 Config v3。中英文发现是已授权目录内的词法匹配，不是翻译或语义搜索；声明 generation 可重建不代表完整会话已重建，命中后仍需持久安装与原执行审批。
- 终端只保留有界展示窗口；缺失 Call/Run 来源、执行耗时或结果时明确未知，不猜配或标为成功。Artifact 只显示 stored/blocked 与受控引用，界面不读取或打开任意输出路径；安全粘贴留稿不是批准。

全局成对性能收益尚未认证，不承诺总体吞吐、时延或资源收益。发布正文只使用经审固定双语说明和唯一提交注入，既有正文冲突停止；最终 Provider、候选与公开回装资格仍须按[正式发布 SOP](README.zh-CN.md)分别取证。

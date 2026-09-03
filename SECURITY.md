# CoreMind 安全策略

安全问题需要私下处理。本页说明如何报告漏洞，以及当前稳定版与开发源码明确提供和不提供的安全边界。

[English](SECURITY.en.md)

## 支持范围

| 版本 | 安全更新 |
| --- | --- |
| `0.7.x` 最新稳定版 | 支持，按风险和可复现性处理 |
| `0.3.1` | 仅处理重大安全问题；建议升级到最新稳定版 |
| 更早的 Alpha/Beta/RC 版本 | 不保证；通常要求升级后复测 |
| 未发布分支或个人 Fork | 不在项目支持范围内 |

## 私下报告漏洞

请先查看仓库 Security 页面是否提供 **Report a vulnerability** 私密入口，并优先通过该入口提交。不要在公开 Issue、讨论区、Pull Request 或聊天记录中披露利用细节。

报告请包含：受影响版本、平台、前置条件、最小复现、实际影响、建议修复方向，以及你是否已经向第三方披露。请删除 API 密钥、个人数据和业务数据。如果私密入口不可用，可创建一个不含技术细节的公开 Issue，仅请求维护者提供私密联系方式。

维护者会尽快确认收到报告、验证影响并协商披露时间；这是响应目标，不是服务等级承诺。

## 当前安全边界

### 权限模式

`ask`、`assisted` 和 `full` 控制审批策略，但不会把高风险工具自动变安全。显式拒绝、工作区路径限制、审计、Trace、预算、checkpoint、Effect Receipt 和恢复检查仍优先执行。首次运行陌生项目时应选择 `ask`。

### Shell 与工具隔离

- Linux：内置 `bash` 在操作系统级隔离中运行，固定禁止网络、仅允许写工作区，并在隔离不可用时拒绝执行，不回退宿主 Shell。该能力的关键依赖仍处于研究预览阶段。
- Windows：一期没有与 Linux 对等的操作系统级 Shell 隔离。宿主 Shell 只有在 `mode: full`、`workspaceOnly: false`、`network: allow` 三项同时明确选择时开放；其他组合全部拒绝并提示改用路径感知文件工具或隔离的 Linux 环境。发现 Git Bash 只解决命令解释器兼容性，不提供隔离。即使开放 Shell，显式 deny、Trace、Checkpoint、Diff、审计和恢复仍然生效。
- 自定义 TypeScript/Python/脚本工具：必须声明 `effect.operations`、`effect.reversible` 和非标准目标字段；不会自动获得操作系统隔离。工具作者仍负责输入校验、最小权限、超时、幂等和副作用控制。

不要运行来源不明的配置、Skill、脚本或工具定义。

### 执行环境能力证据

CoreMind 通过 ExecutionEnvironment probe 观测实际能力；平台名、Adapter 名称、配置字段或历史测试不能替代当前进程证据。Linux sandbox 首次使用时负向验证工作区外写入、敏感环境变量隐藏和网络阻断，并同时验证完整进程树终止；任一 probe 缺失、虚报或不满足调用要求都失败关闭。Windows Trusted Host 如实报告无 sandbox、路径与网络不受限，不能满足隔离或受控 egress 的任务必须拒绝或转移到另行验证的环境。

AgentDriver 只隔离模型 reactive loop，不能直接写权威 Fact、决定恢复或绕过唯一 ToolExecutionEngine。进程、网络和临时资源都参与 Quiescent；取消后的清理失败不能伪装成成功静止。

### Protocol v2 控制边界

Protocol v2 `RunHandle` 只表示启动请求已接受，不表示 Provider 已调用、工具已授权或运行成功。`accepted` 控制回执也不等于 `applied`；Cancel ACK 不等于 Abort、终态或 Quiescent。控制先进入持久 ControlInbox，再由 Runtime 产生权威 Fact。客户端断线默认不取消运行，重连按 `(runId, sequence, eventId)` 去重；Projection query 可重建但不能写回成为事实或授权。v1 在整个 `0.4.x` 保留迁移入口。

### 密钥与数据

- 密钥只通过环境变量注入，不写入 YAML、源码、日志、Trace、截图或测试样例。
- Trace 在写入 RunState 和转发给观察者前会递归脱敏密钥、Token、口令、认证头、Cookie、私钥与凭据字段；URL 凭据/敏感查询参数及命令中的敏感值也会替换。普通测试命令保留可审查性，正文类字段只保留长度标记。
- 本地 Observability 默认显性可见，但只从 canonical facts 生成本机 Projection；启用本地视图不等于同意外传，Projection 也不能写回并成为恢复权威。
- Telemetry 默认为 `DISABLED`：不构造 Exporter、不读取外传凭据、不发送网络请求。`FEEDBACK_ONLY` 只允许发送持久 consent 覆盖的有界事实前缀；`FULL` 也只允许发送配置生效后的 allowlist 字段。
- 默认内容级别是 `metrics_only`。提示词、回复、工具参数/结果、命令、文件正文、完整路径、环境变量值和凭据不得外传；`content` 必须另行明确授权，不能从 `FULL` 模式推断。
- Exporter 的队列、重试、丢弃、认证、超时或关闭故障只能产生本地观测，不得改变 RunOutcome、Fact sequence、RecoveryDecision 或 EffectState。
- 脱敏不是数据隔离：会话、Checkpoint、质量覆盖记录及非敏感 Trace 字段仍可能包含业务上下文。请按敏感业务数据管理本地状态，使用操作系统访问控制，并自行配置保留和清理策略。

### 恢复边界

Child Run 是独立 Run，不是普通 Tool Call。父策略必须绑定实际 Provider/model、canonical Workspace、权限、工具、执行环境探针和有限 Runtime 预算；子级只能收紧。父取消必须等全部子级终止或暂停、关键 Fact flush 并结构化 join 后才能 Quiescent。恢复发现不明所有权时进入 orphan audit pause，不自动重启。Windows Trusted Host 不能证明 sandbox 或 controlled egress；当前也不支持 durable detach。

Checkpoint 可以恢复框架记录的文件状态；RunState 和 Loop 快照可以从完整稳定边界继续。恢复前会验证记录顺序、配置指纹、输入一致性和工具副作用，文件恢复还会比较工具完成后的指纹，用户或并发进程后来修改过文件时会拒绝覆盖。

工具调用会记录 `started`、`committed` 或 `unknown` Effect Receipt。恢复不会自动重放已提交副作用；`started` 或 `unknown` 要求人工核对。该机制不等于通用的“恰好一次执行”，也不能自动撤销邮件、付款、数据库写入或其他外部副作用。业务工具仍应在自己的持久层实现幂等、收据或补偿流程。

Loop 内部状态机只负责状态迁移；CoreMind 的配置指纹、权限、预算、Trace、终态和恢复判定始终是权威边界。损坏、未知版本或与当前配置不匹配的快照会被拒绝，不能作为绕过安全策略的输入。

## 安全部署建议

1. 使用最小权限账号和独立测试凭据。
2. 限制可访问目录、命令、域名和业务资源。
3. 在投产前完成威胁建模、真实供应商复测和业务级评测。
4. 记录版本、配置摘要和审计证据。
5. 定期执行依赖审计；运行时依赖问题与开发工具依赖问题分别评估。

公开支持不替代业务侧安全评审。请根据业务风险增加进程、主机或基础设施层的隔离。

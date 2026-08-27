# 0.4.x 规格：AgentDriver 与 ExecutionEnvironment

> 配套 ADR：0004～0008
> 目标：把底层模型循环与平台执行能力隔离在两个私有 seam 后
> 状态：accepted（Issue #72）；实现已通过 PR #89 合入 `main` 并完成 Ubuntu/Windows CI，不代表 `0.4.0` 发布或真实 Provider 认证

## 1. 边界与所有权

`CoreMindRuntime` 仍是唯一产品 Runtime。Run、Turn、Tool、Fact、Receipt、Control、Recovery 与 Quiescent 的权威语义由 CoreMind 持有：

```text
CoreMindRuntime / RunContext
  ├─ AgentDriver ── P3 Adapter / Fake Adapter
  └─ ToolExecutionEngine ── ExecutionEnvironment
                           ├─ Trusted Host Adapter
                           ├─ Linux Sandbox Adapter
                           └─ Fake Adapter
```

- P3 Adapter 只负责模型与工具的 reactive loop，不写权威 Fact，不决定恢复，也不能降低 Tool Capability。
- ToolExecutionEngine 仍是唯一可以调用真实 Tool Adapter 的模块；ExecutionEnvironment 不能成为旁路执行器。
- 两个 seam 都位于 `internal` 边界。CoreMind 公共消息、配置、协议与 SDK 声明不得出现底层 AgentEvent、AgentMessage、SessionContext 或完整 ExecutionEnvironment 类型。

## 2. AgentDriver 合同

AgentDriver 只暴露：

- prompt、waitForIdle、abort；
- CoreMindMessage 历史；
- running、pending tool call、queued control 状态；
- steering/follow-up 控制入口；
- CoreMind-owned observation。

Observation 至少覆盖 agent start/end、text delta、turn end、tool start/end。工具 start/end 必须绑定同一 callId、工具名与参数；底层事件缺字段时由 Adapter 在活动 call 生命周期内补齐，agent end 后立即清空。

Fake Adapter 必须确定性覆盖 stream、同批工具、abort、迟到结果丢弃、steering 与 follow-up。生产 Adapter 与 Fake Adapter 共享同一 CoreMind 接口和合同测试；当前不引入第二个生产 Driver。

Steering/follow-up 的权威入口是持久 ControlInbox。Driver 内部队列只是应用层机制，不能替代 accepted/applied/rejected/duplicate/conflict 控制事实。

## 3. ExecutionEnvironment capability schema

探针返回的是实际观测能力与证据，不是配置愿望。当前 schema 包含：

| 维度 | 取值或含义 |
| --- | --- |
| isolation | trusted_host / linux_sandbox / fake |
| readAccess、writeAccess | unrestricted / workspace / none |
| outsideWorkspaceAccess | allowed / blocked |
| networkEgress | unrestricted / adapter_scoped / allowlist / deny_all |
| credentialIsolation | none / environment / environment_and_files |
| processControl | none / process / process_tree |
| termination | kill 范围、timeout、PTY |
| durability | process_memory / critical |
| identity | platform、Adapter 名称与版本 |

Resolver 先校验 probe，再比较 claimed 与 observed，最后验证调用方 requirement：

1. probe 失败，返回 `environment_probe_failed`；
2. 声明强于观测，返回 `environment_capability_mismatch`；
3. 实际能力不满足要求，返回 `environment_requirement_unsatisfied`；
4. inherited 与 requested requirement 合并时逐维取更严格值，子级不能放宽父级限制。

平台名、Adapter 名称、配置字段或测试通过记录都不能代替当前进程的负向 probe。

## 4. 当前 Adapter

### 4.1 Fake

Fake 可分别注入 claimed/observed、probe 状态与 terminate timeout，用于能力虚报、sandbox 缺失、egress 不可控和终止失败测试。Fake 不是生产隔离能力。

### 4.2 Trusted Host

Trusted Host 如实报告 unrestricted 路径和网络、无凭据隔离、无 sandbox。它只有在真实父子进程 probe 证明取消后子进程不存活时，才报告 process_tree kill/timeout。

Windows Trusted Host 不是 sandbox。需要 sandbox、受控 egress 或凭据文件隔离的任务必须失败关闭或改用另行验证的环境，不能把 ACL、worktree 或平台名称描述成完整隔离。

### 4.3 Linux Sandbox

Linux Adapter 使用固定版本的 `@anthropic-ai/sandbox-runtime`。首次需要能力时，probe 初始化真实 sandbox，并负向验证：

- 工作区外写入被阻断；
- 敏感环境变量不进入命令；
- 对宿主本地探针服务的网络连通被阻断。

当前配置允许读取一般宿主路径，只对已列出的凭据文件执行 deny-read，因此如实报告 `readAccess=unrestricted` 与 `outsideWorkspaceAccess=allowed`；不得把“只允许工作区写入”扩大描述为“完全阻断工作区外读取”。

## 5. Resource、Cancel 与 Quiescent

ExecutionEnvironment 为每项受管活动登记 AbortSignal 与 settle：

- ProcessRunner 登记 process，使用调用方 signal 与环境 signal 的并集，并要求完整进程树终止；
- web-fetch/web-search 登记 network；
- Linux sandbox wrapper 与 cleanup 登记 temporary_resource；
- settle 必须位于 finally，迟到结果不能提前释放资源账本。

Quiescent 当且仅当：全部 Agent idle、无 pending tool call、无 queued control、journal 无 pending flush，并且 ExecutionEnvironment 没有活动资源。

Runtime cancel 同时 abort Driver 与 terminate Environment。terminate 在时限内仍有资源时返回 `environment_terminate_failed`，Runtime 不得把该清理失败投影成成功静止。Worker close/stdio EOF 发出 abort 后等待在飞 Runtime 的 finally；超时只能返回 `quiescent:false`。

## 6. Durability 与 PTY 边界

当前本地环境资源账本是 `process_memory`；它不能满足要求 `critical` 的未来远程/持久资源合同。Run Fact 的 critical durability 仍由 FactLedger/RunStore 负责，二者不能互相冒充。

当前 Adapter 不声明 PTY 能力。真实 PTY、终端 resize、detach/reattach 与跨进程恢复属于后续独立实现和双平台验收，在此之前要求 PTY 必须失败关闭。

## 7. 验收与证据分层

本 Issue 的工程门包括：

- Fake/Production AgentDriver stream、tool batch、abort、late result、control 合同；
- 环境虚报、probe 缺失、terminate 失败、不受控 egress 与单调约束测试；
- Windows/Linux 真实进程树测试；
- Linux sandbox 负向 probe；
- Runtime cancel、Worker close/EOF、cleanup 与 Quiescent 收敛；
- 公共声明扫描，不出现私有底层类型；
- 全量 check、测试、稳定性、覆盖率与文档门。

Windows 本地通过不能替代 Linux CI；离线 faux Provider 不能替代真实 Provider 认证；PR 合并不能替代发布候选、tag、Registry 或人工产品验收。

## 8. 非目标

本规格不授权：

- 升级 P3 或 sandbox 依赖；
- 实现 WSL/remote environment、MCP、Subagent/Child Run；
- 新增第二 Runtime；
- 自动提交、推送、PR、合并、tag、发布或真实外部 Provider 调用。

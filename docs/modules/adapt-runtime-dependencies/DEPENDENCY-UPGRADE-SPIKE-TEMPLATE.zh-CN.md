# Runtime 依赖升级 Spike 模板

> 本文件是调查与验收清单，不授权安装依赖、外部调用、提交、PR、合并或发布。复制后填写；不得直接改写模板中的占位语义来规避门禁。

## 1. 身份与范围

- Spike 编号：`<编号>`
- 负责人：`<姓名>`
- 日期：`<YYYY-MM-DD>`
- 参考版本：`<包名>@<精确版本>`
- 候选版本：`<包名>@<精确版本>`
- 上游 tag/commit：`<完整 commit SHA>`
- Lockfile 哈希（前/后）：`<SHA-256>` / `<SHA-256>`
- 受影响私有 seam：`<Provider / AgentDriver / Session / Tool / ExecutionEnvironment>`
- 明确非目标：`<不在本 Spike 内实现的能力>`

核心依赖必须整体列出并固定精确版本，禁止只记录直接依赖或使用范围版本：

| 包 | 参考版本 | 候选版本 | 传递依赖变化 | 许可证/NOTICE | 结论 |
| --- | --- | --- | --- | --- | --- |
| `<package>` | `<x.y.z>` | `<x.y.z>` | `<摘要>` | `<证据>` | `<待评估>` |

## 2. 变更与风险假设

- 上游协议/事件/消息变化：`<事实与链接>`
- 工具调用与并发变化：`<事实与链接>`
- abort/timeout/late result 变化：`<事实与链接>`
- Session 格式与恢复变化：`<事实与链接>`
- Usage、费用与错误分类变化：`<事实与链接>`
- 平台/sandbox/进程树变化：`<事实与链接>`
- 供应链、维护状态与漏洞：`<事实与链接>`
- 可能影响的 CoreMind 不变量：`<列表>`

把“上游文档声称”和“本候选实际探针”分开记录；没有 probe 的能力标记为未充分验证。

## 3. 红灯与最小 Adapter 计划

先写失败合同，再修改私有 Adapter：

| 合同 | 改动前红灯 | 候选绿灯 | 证据路径 |
| --- | --- | --- | --- |
| Provider stream/final message | `<结果>` | `<结果>` | `<日志/测试>` |
| Tool batch/顺序/并发 | `<结果>` | `<结果>` | `<日志/测试>` |
| Abort/late result/Quiescent | `<结果>` | `<结果>` | `<日志/测试>` |
| Session roundtrip/旧 fixture | `<结果>` | `<结果>` | `<日志/测试>` |
| AgentDriver observation | `<结果>` | `<结果>` | `<日志/测试>` |
| ExecutionEnvironment probe | `<结果>` | `<结果>` | `<日志/测试>` |

允许修改的文件：`<Adapter 与合同测试>`

禁止修改的公共合同：`<Config / Protocol / SDK / Fact / Outcome / Recovery>`

## 4. 协议与恢复兼容

- Protocol v1 fixture：`<通过/失败/不适用 + 证据>`
- Protocol v2 schema/fingerprint：`<通过/失败/不适用 + 证据>`
- 同一 Facts → 同一 RunSnapshot：`<证据>`
- 同一 Facts → 同一 RecoveryDecision：`<证据>`
- legacy Session/RunState 只读兼容：`<证据>`
- 公共声明私有类型扫描：`<证据>`
- 无第二 Runtime/入口旁路：`<审查结论>`

## 5. 四入口与双平台矩阵

每格必须记录实际命令、退出码、运行标识和日志哈希；“计划运行”不能填写为通过。

| 平台 | CLI | TUI | TypeScript | Python Worker |
| --- | --- | --- | --- | --- |
| Windows | `<证据>` | `<证据>` | `<证据>` | `<证据>` |
| Linux | `<证据>` | `<证据>` | `<证据>` | `<证据>` |

补充合同：

- process tree kill/timeout：`<Windows证据>` / `<Linux证据>`
- sandbox/egress/credential 负向 probe：`<证据>`
- PTY（若声明支持）：`<证据；否则明确 unsupported>`
- Cancel → Quiescent 与 Worker exit：`<证据>`

## 6. Provider 与外部边界

- 离线 faux/replay：`<证据>`
- 真实 Provider 认证：`<未授权 / 已授权范围 / 证据>`
- 精确出站内容：`<provider、endpoint、模型、消息/工具 schema 范围>`
- 凭据来源与生命周期：`<仅进程内，不落盘>`
- 费用上限：`<金额/请求数>`

离线测试、CI、PR Ready 或 checksum 不能替代真实 Provider 认证；真实认证也不能自动授权发布。

## 7. 性能与供应链

- 安装树唯一版本族：`<证据>`
- clean install / build / tarball：`<证据>`
- 包体变化：`<前/后/阈值>`
- Provider 首 token、工具启动、Run 完成基线：`<前/后/结论>`
- 许可证、NOTICE、签名/来源：`<证据>`
- security audit：`<证据与处置>`

## 8. 回滚演练

- 回滚点（branch/SHA/Lockfile 哈希）：`<值>`
- 整体回滚包集合：`<列表>`
- 回滚命令：`<非破坏命令>`
- 回滚后 build/test/four-entry 证据：`<路径>`
- 新候选产生的数据是否可由旧版本读取：`<结论>`
- 无法回滚的外部副作用：`<无 / 明细与人工处置>`

禁止混搭新旧核心依赖；禁止通过重写历史 Session/RunState 完成回滚。

## 9. 结论与独立授权门

- Spike 结论：`<Go / No-Go / 需补证据>`
- 未解决风险：`<列表>`
- 推荐候选版本：`<精确版本或不升级>`
- 实现授权：`<未请求/已获得>`
- Git/PR 授权：`<未请求/已获得>`
- 真实 Provider 授权：`<未请求/已获得>`
- Release candidate 授权：`<未请求/已获得>`
- merge/tag/publish 授权：`<未请求/已获得>`

上述授权彼此独立，不得从“继续”“同意方案”或一个通过的门禁推导后续权限。

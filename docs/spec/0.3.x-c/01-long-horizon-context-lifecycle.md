# 0.3.x-C 规格：长程上下文生命周期

> 配套 ADR：[0005-long-horizon-context-lifecycle](../../adr/0005-long-horizon-context-lifecycle.md)
> 目标版本：`0.3.3`；版本号不是发布日期或发布授权
> 状态：accepted（2026-08-22 用户确认）

## 1. 当前基线与补强边界

CoreMind 当前已在每次 Provider 请求前执行本地确定性 Context 保护：超过 `contextWindow - reserveTokens` 时，用摘要与最近完整轮次替换旧前缀；持久 Session 可追加非破坏性 compaction 条目，失败产生 `context_compaction_failed` 并保留原消息。

本规格不重新实现 Session，也不承诺无限上下文。它补足不同模型窗口、请求真实开销、反复压缩、模型切换和无法安全压缩时的终态合同。

## 2. Resolved Context Capability

每次 Provider 请求前生成不可变的 `ResolvedContextCapability`：

| 字段 | 含义 |
| --- | --- |
| `providerId / modelId` | 即将调用的精确路由，不使用 Session 创建时的旧值 |
| `contextWindow` | 解析后的有效总窗口 |
| `maxOutputTokens` | 本次允许的最大输出或安全上限 |
| `source` | `locked_catalog / explicit_config / provider_metadata / conservative_fallback` |
| `confidence` | `verified / declared / assumed / conflicting` |
| `configFingerprint` | 路由、模型与预算相关配置的稳定指纹 |
| `resolvedAt` | 解析事实时间，不代表 Provider 永久不变 |

规则：

- 多个可信上限同时存在时取安全交集，不取最大值。
- 内置模型目录是锁定依赖快照，不等于实时 Provider 承诺；真实认证仍绑定当前候选版本。
- 自定义端点缺少窗口时可为兼容采用保守 fallback，但必须产生 `assumed_context_window` 证据并允许用户显式收紧。
- `conflicting` 或无法满足最小安全预算时，在 Provider 调用前失败，不猜测更大窗口。
- 同一 Runtime 若未来支持异构 Agent，每个 Agent/Turn 都按自己的具体模型解析，禁止共享一个全局窗口数值。

## 3. 请求预算

```text
availableInput = effectiveContextWindow
               - reservedOutput
               - stablePrefixTokens
               - toolSchemaTokens
               - protocolAndStructuredOutputOverhead
               - estimationSafetyMargin
```

- token 计量应优先使用与 Provider/模型匹配的计数器；只有不存在时才用保守估算并标记来源。
- `reservedOutput` 不得只按固定常量，应受模型上限、本次配置与任务最小输出需要约束。
- 工具 Schema、系统/稳定前缀、结构化输出描述、图片/多模态占用和协议包装都必须进入预算。
- 预算投影进入本地 metrics 与事件，但提示正文不进入脱敏 Run Fact。

## 4. Context Working Set

工作集从 Session / Run / Workspace canonical facts 生成，而不是从 UI 缓存或上一轮 Provider 请求反推。

### 4.1 不可静默删除集合

- 核心规则、项目指令与当前 Skill 合同；
- 当前用户目标与显式约束；
- 已批准、拒绝和仍待处理的权限决定；
- started/committed/unknown Effect 与恢复处置；
- 当前活动计划、未完成步骤和下一步；
- 已修改文件、关键测试证据和未解决失败；
- 至少一个满足工具消息配对的最近完整 Turn。

不可静默删除不代表全文永久进入每次请求；允许将其投影为有类型、可回溯的 TaskState，但必须能指向来源 Fact。

### 4.2 分级收缩

1. 大型工具输出先外置到受控 Artifact，工作集只保留有界预览、哈希、媒体类型与相对引用。
2. 删除可重建的普通 delta 和重复 UI Projection。
3. 对已经闭合的旧 Turn/span 做确定性压缩，保留最近完整区。
4. 如果仍超预算，收紧非关键历史并重新计数。
5. 不可静默删除集合仍超限时，产生 `context_budget_exhausted`，暂停且不调用 Provider。

## 5. Compaction Ledger

每次压缩追加 Session Fact，至少记录：

- 源条目范围与源指纹；
- strategy id/version；
- Capability 与预算来源引用；
- tokens before/after 与估算器标识；
- summary、retained tail 与 summary fingerprint；
- parent compaction id 与 lineage depth；
- 创建时间和触发原因。

原始 Session 历史不删除。达到实现期冻结的 lineage depth 阈值后，必须从 canonical facts 重新投影新的基线摘要；不得无限对上一版摘要继续摘要。

## 6. 模型切换与恢复

### 大窗口 → 小窗口

1. 记录 model/capability change；
2. 从 canonical facts 重建 TaskState 与候选工作集；
3. 按新窗口执行分级收缩；
4. 重新计数并通过硬预算后才调用新模型。

旧模型生成的摘要可以作为来源节点，但不能仅凭“此前可发送”证明适配新模型。

### 小窗口 → 大窗口

保持当前工作集，不自动把全部归档原文重新注入。历史只能通过有界、可审计检索按需恢复，避免任务焦点漂移和无谓 token 消耗。

### 崩溃恢复

恢复端以 Compaction Ledger、TaskState Projection 与 canonical facts 重建同一请求。摘要正文不得只存在于内存、Trace 或 OTel。

### Provider 超窗错误

记录 Provider 观测与 Capability 冲突；不得用相同请求无限重试。只有收紧 capability、重建工作集并再次通过预算后才允许新 attempt。

## 7. 失败语义

| 情况 | 结果 |
| --- | --- |
| 压缩回调失败但原文仍在预算内 | 产生失败事件，可继续原请求 |
| 压缩失败且原文超预算 | `context_budget_exhausted`，暂停 |
| Capability unknown/conflicting | 请求前失败或要求用户提供上限 |
| 不可删除集合超预算 | 暂停，不截断 |
| Artifact 无法读取 | 保留引用失败证据，不虚构内容 |
| lineage 损坏 | `context_lineage_corrupt`，禁止从损坏摘要继续 |

## 8. 兼容与非目标

- 现有 Config 的 `contextWindow` 与 `session.compact` 保持兼容；新增配置只能显式收紧或选择策略，不能暗中扩大窗口。
- 请求级确定性保护继续默认启用；可选 LLM Session 摘要不成为安全前提。
- 不自动创建跨项目 Memory，不把 Session 事实上传，也不承诺无界任务永不暂停。
- 真实模型窗口、tokenizer 和长上下文质量必须在候选版本重新认证，离线 fixture 不能替代。

## 9. 验收

实现验收见 [0.3.x-C 验收矩阵](03-acceptance-matrix.md)。

# 模型供应商认证 SOP

CoreMind 能识别某个供应商，只代表运行时具有对应适配入口；只有完成本页全部真实测试并保存证据后，才能标记为“已认证”。当前认证结果见[供应商矩阵](./README.zh-CN.md)。

## 认证前提

1. 使用供应商官方账号、正式 API 地址和可公开验证的模型标识。
2. 由测试人员明确批准把测试输入发送给外部服务。
3. API 密钥只通过环境变量注入，不写入配置、日志、截图或提交记录。
4. 记录 CoreMind 版本、操作系统、Node.js 版本、供应商、模型和测试时间。
5. 测试内容不得包含个人信息、商业秘密或生产数据。
6. 执行前明确批准 Provider、模型、凭据来源、费用上限、最长运行时间、候选提交和 Runtime 候选包 SHA-256。

### 阿里云 qwen-plus 的费用前置条件

内置 `alibaba-model-studio` 使用北京通用接入点；域名中的 `trial` 不代表免费，该地址也用于[按量付费](https://help.aliyun.com/zh/model-studio/base-url)。模型元数据中的零费率和 `turn_end` 后的用量统计都不能证明本次费用上限。

当前阿里云认证只接受 `qwen-plus`。操作人必须先在控制台核实该模型仍有未过期、未耗尽的免费额度，且“免费额度用完即停”已经生效；未确认则不得执行。开关存在生效延迟，普通预算的“立即停止”也可能在延迟期间继续计费，不能替代上述保护。参见[免费额度说明](https://help.aliyun.com/zh/model-studio/new-free-quota/)和[预算管理](https://help.aliyun.com/zh/model-studio/budget-management)。

核实后，才能将 Candidate Qualification 的 `alibaba_free_quota_only_confirmed` 设为 `true`；默认值为 `false`。本地认证脚本对应环境变量为 `COREMIND_CERT_ALIBABA_FREE_QUOTA_ONLY_CONFIRMED=true`。该标记仅记录操作人的账号状态声明，不是程序自动核验；证据以固定 `billingControl` 值 `operator-confirmed-alibaba-beijing-qwen-plus-free-quota-only` 保存这项边界。原单次授权、费用上限、零重试、候选身份与全部超时仍然适用，确认标记不代表真实认证已通过。

阿里云认证从 GitHub Actions Secret `COREMIND_CERT_API_KEY` 注入密钥，不要把密钥放入工作流输入或认证证据。内置北京 `qwen-plus` 请求使用 `max_tokens`；命名 Agent 切换模型时重新选择输出上限字段，其他自定义端点保留原行为。字段兼容不等于费用保护或真实服务验收，参数语义见[官方 API 文档](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。

### DeepSeek 的人民币认证预算

此路线固定使用 `deepseek` / `deepseek-flash`，密钥由 GitHub Actions Secret `DEEPSEEK_API_KEY` 注入，账号结算币种须为 CNY。Candidate Qualification 的 `max_cost_cny`（本地环境变量 `COREMIND_CERT_MAX_COST_CNY`）必须填写本次明确批准的人民币金额；批准记录保存 `maxCostCny`、`billingCurrency: "CNY"` 和 `billingControl: "deepseek-flash-cny-reserved-v1"`。原 `max_cost_usd` 与 SDK 费用估算门独立保留，不进行币种转换或额度抵扣；阿里云路线沿用上节前提。

认证固定 `maxTokens: 1024`、`thinkingLevel: "off"`。按[官方人民币高峰单价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)预留：未命中输入每百万 token 2 元、输出每百万 token 8 元。每笔请求外发前均按完整输入窗 1,048,576 token 加 1,024 输出 token 预留 **2.105344 元**，不以字符估算、预期缓存命中或当前已观察用量代替请求上界。

全次认证共享一个预留账本，覆盖父模型、子 Agent、失败和取消请求。仅在收到完整且可信的 usage、结束原因和 `[DONE]` 后，才按用量释放该笔差额；其余情况保留整笔预留。可用认证预算不足以预留时，在请求发送前拒绝；这种本地拒绝不代表鉴权测试通过，无效密钥检查仍须实际发送一次请求并收到真实 HTTP 401。零重试、原验收与全部超时不变。

离线实现和双平台工程 CI 通过后，必须以新的候选提交及 Runtime 包 SHA-256 申请一次真实认证批准，明确人民币金额和外发边界。旧授权、已保存密钥或预算门拒绝均不能代替批准，也不代表已认证或已发布。

## 强制检查

| 检查 | 通过条件 |
| --- | --- |
| 流式输出 | 能持续接收增量内容，结束原因与最终文本完整 |
| 工具调用 | 模型产生合法参数，工具结果能回传并继续生成答案 |
| 结构化结果 | 输出满足声明的结构，非法结果能被拒绝或修复 |
| 多轮会话 | 上下文在至少三轮交互中保持正确，没有角色串线 |
| 中止 | 活动生成能被显式中止，终态为 `aborted`，中止后 Runtime 可继续使用 |
| 错误处理 | 无效密钥、限流、超时和服务端错误均返回可诊断结果，不泄露密钥 |
| 长上下文 | 在记录的合成长文本长度下仍能返回首尾标记，不混入真实用户或业务数据 |
| 父子 Agent 产品链 | 父模型调用 `delegate`，Child 使用同一批准 Provider 调用受控工具，结构化结果回传父级；活动 Child 取消后在有界时间内零活动后代 |

## 执行步骤

1. 从最小配置开始，仅启用一个供应商、一个模型和一个受控合成工具；有副作用工具只能写入本次临时工作区。
2. 运行全部检查，同时保存脱敏后的批准边界、配置摘要、结果摘要和用量；不得保存凭据值、原始 Trace 或合成正文。
3. 任一检查失败、超限或出现未知 Effect 时立即停止，不自动重试，也不生成成功记录。
4. 仅在全部检查通过后更新 `docs/providers/certifications.json`。
5. 执行 `npm run build && npm run providers:matrix` 重新生成双语矩阵。
6. 执行 `npm run check` 和 `npm test`，确认矩阵、文档与运行时清单一致。
7. 由另一位维护者复核证据、外发授权和脱敏结果后合并。

## 证据要求

认证脚本失败时，会在清理临时工作区前尝试写出一条 `COREMIND_CERTIFICATION_FAILURE` 固定字段日志和独立的 `.scratch/provider-certification-failure.json`（至多 4 KiB）。严格候选工作流独立上传 `provider-certification-failure-<commit>`，不修改成功台账。摘要只包含候选身份、阶段、父子链计数/布尔/枚举、审批计数及已观察用量；不保存正文、工具参数、路径、凭据或任意异常。父子链必须具有成功的工具回执，错误回执不能代替完成。

合成认证提示明确给出 `delegate` 和 `write` 的 JSON 参数，审批仍逐字匹配目标、任务及写入内容。父子成功链的审批拒绝只记录固定分类（目标、任务、路径、内容不匹配，意外 Agent/工具，或未分类拒绝）；未知分类为 `unknown`。该分类绑定实际被拒的请求，不从同批工具事件推断具体参数，也不能作为放行依据。

失败用量标记为 `partial` 或 `unknown`；缺值为 `null`，不能视为零费用、完整账单或可再次使用的剩余额度。输出故障不改变原认证失败与清理；进程被强制终止时不保证能留下记录。失败诊断不能作为认证资格，后续真实验证仍须获得明确批准。

认证记录至少应包含供应商标识、模型标识、CoreMind 版本、候选提交、Runtime 与候选包摘要、测试日期、平台、全部检查、长上下文字符数、父子链结果、取消收敛时间、零重试脱敏用量和证据链接。证据可以存放在不含秘密的 Issue、CI Artifact 或测试报告中；链接失效、缺少当前检查或证据不可复现时必须降级为未认证。

## 何时撤销认证

供应商接口发生破坏性变化、默认模型下线、连续集成复测失败、发现安全问题，或超过一个主要版本未复测时，将状态改回“未认证”，修复并重新执行完整 SOP。

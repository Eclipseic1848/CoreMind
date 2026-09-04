# 宿主验收与同 Run 有限修正

状态：当前开发分支的实现合同；不是已发布 0.7.1 的能力，也不触发新版本发布。

## 范围与所有权

宿主需要在 Run 成功前独立检查候选。CoreMind 负责执行、持久控制、有限修正、取消、恢复和运行终态；宿主负责业务规则、授权及正式交付。宿主接受候选不授予工具权限，也不能把失败、预算耗尽或取消改成成功。

复用现有 LoopController，不另建 Runtime，不要求宿主自建修正循环。现有 Agent 验证模式保持兼容。

## 公开接口

配置 `loop.verify: { mode: host, timeoutMs: 60000 }`，execute/repair 与迭代、修正、重复动作限制使用原有 Loop 配置。host 模式不执行验证模型，不评估模型的 PASS 文本；超时是每次验收等待的上限。

TypeScript Runtime 通过 `onVerification(request)` 通知显式宿主。回调返回值没有批准效力，宿主调用同一 Runtime 的 `acceptControl` 回复。Protocol v2 使用 `hostVerification` 能力、`verification_request` 通知与 `verification` 控制；Python 提供相应接收和提交接口。不支持的入口必须明确拒绝，不能退回仅文本判断。

请求字段：schemaVersion=1、runId、requestId、stepId、iteration、candidateSha256、candidate。SHA-256 对应 candidate 字符串的 UTF-8 字节，不是可变工作目录或外部业务对象的自动认证。宿主须自行核对候选关联的业务对象、权限和不可变数据版本。

回复包含 schemaVersion=1、controlId、runId、type=verification、requestId、candidateSha256、decision=accept/reject、feedback。拒绝反馈必须非空；接受时可为空。反馈会进入后续模型输入，不得放入密钥或不应交给模型的数据。

## 持久化与恢复

1. 候选 Step 输出与验证请求先稳定落盘，再通知宿主。请求事实只记录身份和摘要；候选正文复用既有 Step 输出事实，不另造事实源。
2. 回复复用 ControlInbox 的 critical accepted/applied。只有 applied 持久化完成才释放 Loop 等待。accepted 不是验收生效。
3. 同 ControlId 同内容幂等、不同内容冲突；同 requestId 换 ControlId 不能覆盖首个已应用决定。错误 Run、请求身份或摘要不能放行。
4. reject 反馈作为控制事实保存，再由原 Loop 进入 repair。崩溃发生在 applied 与 Loop 快照之间时，重建同一个决定和反馈，不重复消费修正额度。
5. 请求已持久但没有决定时，结果保持未知。恢复重新通知同一对象；不能自动接受、把未知当 reject，或恢复已完成 Run 来另做新任务。
6. 请求 ID 必须唯一；对象摘要、Step/iteration 不匹配或损坏事实失败关闭。更改 host 验证配置不能绕过原 Run 的配置指纹。

## 取消与失败

等待宿主不能占住控制收件箱锁。取消仍走原 Runtime 收敛路径；中止后迟到回复不得产生成功或新的修正。

没有宿主接口、通知抛错或等待超时产生 paused，绝不是业务验收通过。暂停后的控制接收只表示收件，恢复应用仍要核对原请求。修正达到原有额度、无进展、工具失败及预算耗尽继续服从原终态规则。

验收等待期间拒绝 steering/follow_up 改变待验收输入。Node 的交互 `runAgentTurn` 不提供这个控制绑定，明确拒绝 host 模式；使用 `run()` 及其绑定控制接口。

## 验证要求

- 真实 Runtime + localhost 模型替身：拒绝、同 Run 修正、接受及有限额度。
- 对象身份、重复 ControlId、换 ID 重答与冲突；模型文字不能绕过。
- 未决暂停冷恢复、applied 后崩溃前缀恢复、损坏请求身份拒绝。
- 等待中取消、静止、迟到回复及缺失/异常宿主。
- Protocol v2/Worker/Python 接口、旧入口拒绝与 Schema 身份同步。

不调用真实 Provider，不修改消费者仓库，不发布 npm/PyPI/GitHub Release。消费者升级必须固定新的源码与构建摘要；不可把本能力写成原 0.7.1 制品已经提供。

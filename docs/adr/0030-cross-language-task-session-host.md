# 跨语言任务与会话管理复用唯一 Node Host

## 状态

v1.4.0 开发线采用，关联 #367。工程、双平台 CI、合并与发布分别验收。

## 决策

- Protocol v2 新增 task/session 两个操作入口，使用 durableTasks/sessionBranches 独立协商与完整 Schema 指纹。请求绑定 initialize 的 sessionId，不提供任意目录、模块路径、源码或凭据入口。
- Node 宿主启动时通过 runStdioWorker 第三个参数注册可信任务定义、文档 Schema 和原 Runtime 绑定。默认 Worker 不注册任务，因此显式拒绝任务能力；会话导航可独立使用。Python worker_command 是宿主启动选择，不是远程模块加载器。
- Worker 复用 TaskSession、ChatSession、原 Session/Run/TaskCommit 事实和 writer 规则。无第二 Runtime、Python 事实库或调度器。任务模型/工具继续使用原权限、预算、超时、审批、取消与副作用恢复门。
- 工具审批、注册任务的信任、配置项目代码加载分别控制。初始化信任开关的实际值与宿主 authorityVersion 一起绑定任务权限身份，防止只哈希回调源码而遗漏闭包值。其他外部策略/凭据路由变化仍由宿主更新 authorityVersion。
- TS ProtocolV2SessionClient 复用注入的 RPC request；Python 同步/异步 API 复用原 Worker 生命周期和错误类。两端校验 DTO、能力、任务/会话/唤醒身份；Python 不序列化 callable。
- TaskExecutionError/TaskCallError 的子码放在 error.data.details.taskCode。顶层沿用原 Error Contract，不改变原 Run 的错误分类。details 同时绑定 operation/action/sessionId/taskId。
- 活动任务阶段可查询与取消；竞争执行、普通 Run、导航和 checkpoint 修改拒绝。原 shutdown 5 秒与输出收尾 10 秒保持。取消请求、RPC 失败不证明效果回滚。

## 兼容与限制

旧 v1 行为保持。新 SDK 通过指纹/能力拒绝旧 Worker；旧 SDK 不应接管新任务调用账本或持久会话选择。回滚先停 writer，保全所有事实域并恢复升级前备份。Session 树为未脱敏完整消息，宿主负责访问授权；绑定一个 sessionId 不构成多租户认证。

等待期限由宿主唤醒和显式 resume，不自动后台执行。可信处理器仍是普通 JavaScript；不承诺持久 JS 栈、裸 I/O 重放保护或外部 exactly-once。未知外部效果继续暂停核对。

## 验证

协议/Worker 单测覆盖越权、错误身份、能力、闭包信任变化、并发取消和项目代码/工具拒绝。python/tests/test_session_management.py 使用真实 Node 子进程与相同事实比较 TS、同步/异步 Python；在 Run 结果已提交而阶段尚未提交时退出，重启确认同一 Run/key/result 和单次效果，并覆盖等待/唤醒、分支/fork。保留原 v1、错误合同、Worker 依赖身份、包安装与双平台门禁。

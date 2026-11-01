# 受写租约保护的公共会话树导航

## 状态

v1.4.0 开发线采用，关联 #366；本决策不等于 CI、合并或发布资格通过。

## 决策

- coremind-ai 的 ChatSession 暴露 inspectSessionTree/createBranch/selectBranch/fork 和稳定 DTO。用现有 CoreMindRuntime.create 的 sessionId 重新打开，不公开 SessionStorage 写能力。
- 命名分支复用 session-v4 lane，一个 Session 只有一个持久选择；消息、维护和压缩均写所选分支。每轮 chat 仍创建独立 Run/Agent。
- 选择事实使用保留 lane coremind/navigation/v1 上的 coremind.session-branch.v1 自定义条目。它不进入消息历史；完整追加确认后才改变内存选择。首次选择可先写空保留 lane，不承诺整个操作回滚。
- 所有导航要求 Runtime 空闲、主 Agent 和启用持久 Session，使用原 Session lease、短 I/O 锁及 watermark。修改必须匹配 Chat 历史水位。查询也取得短期写身份，因为打开可能修复坏尾或公开别名；它不隐式刷新旧 Chat。
- 分支从当前会话消息节点或空历史创建，不自动选择。节点引用绑定 sessionId；未知/跨会话节点、非法名称、重复创建明确拒绝。没有删除、重命名或任意路径选项。
- fork 复用 JsonlSessionRepo 的 branch fork，包含目标消息及祖先，产生新 UUID 并保存来源 sessionId/entryId。保留历史、压缩、标签和名称，不复制 lane 操作记录、Run store、控制输入、收据、checkpoint 或凭据授权。历史工具 id 不成为执行身份。
- fork 只返回树 DTO；调用方显式应用宿主配置打开新 Runtime，新 Run 沿用原预算、审批、权限和取消规则。它不是恢复原 Run、外部副作用重放或 第三方 ExtensionAPI 兼容层。

## 失败与兼容边界

- 选择写入可能实际落盘后失去确认。拒绝不代表回滚；保留文件并重新打开，旧 Chat 不猜测后继续。原坏尾修复、别名/inode 校验、超时与锁恢复保持。
- fork 内部文件提交与公开 hardlink 发布不是一个事务。别名失败报告 session_alias_failed，并保留完整候选；按错误路径核实身份后打开，不删除来源或盲目重试 fork。
- 旧 v3 迁移与无分支 v4 保持兼容，无选择事实时默认 main。旧 SDK 不理解新选择记录，可能继续写 main；禁止直接接管新文件。回滚先停 writer，保全整个 Session/Run/Workspace，再恢复升级前备份，不能只复制公开别名。
- session_navigation_invalid 注册为 failed/fatal；其他分类不变。协议 v2 Schema 指纹与生成 Worker/错误表同步更新，不新增 RPC/Python 导航方法；跨语言传输归 #367。
- DTO 消息未脱敏，宿主负责认证和访问授权。查询返回完整树，暂无分页；不承诺网络文件系统、断电事务或多租户 ACL。

## 验证

公共包示例与独立 Node 子进程验证无 deep import；假 Provider 捕获分支请求上下文。覆盖旧数据、压缩、空分支、控制/执行记录隔离、新审批、并发 writer、跨会话节点及选择/别名写故障；原模块和工程门禁继续适用。

# Release Candidate 验收指南

当前验收目标为 `1.3.0` 发布线。历史 `0.7.0` 网络例外与 `0.7.1` 离线晋升均不可复用；本版本须完成全部严格检查。公开可安装状态以 Release、Registry 实时页面与同提交资格证据为准，源码 CI 通过不等于发布。

本轮 #324–#333 修复按既有矩阵与模块回归复验；范围和迁移边界见[完整发布说明](notes/v1.3.0.md)与[1.2→1.3 迁移](../migrations/1.2-to-1.3.zh-CN.md)。P01～P20 及原严格资格要求保持不变。

本指南用于验证同一候选提交上的 CLI/TUI、无头 CLI、TypeScript SDK、Python SDK 与发布物。自动测试、真实终端和真实 Provider 是三类独立证据，不能互相替代；`0.7.0` 的维护者网络例外必须单独标为 waived，不能冒充真实 Provider 成功。


[English](RC-ACCEPTANCE.en.md)


## 1. 自动矩阵

在候选源码根目录执行：

```powershell
npm run acceptance:rc
```

该命令会运行完整 Node 测试、Python SDK/真实 Worker 测试、统一版本预检、8 个 npm 包的内容、publint、类型解析与干净项目安装，以及 wheel 内容与干净安装检查。每个 P01～P19 Case 还必须绑定到具体测试文件和测试标题；只要测试锚点缺失，即使整套测试退出码为 0，RC 仍失败。

在执行 RC 矩阵前还必须运行 `npm run baseline:check`。该命令先重建全部公开包，再比较冻结类型合同；不得直接复用旧 `dist` 作为源码无漂移的证据。

| Case | 验收目标 | 入口 |
|---|---|---|
| P01 | 普通问答与完整终态 | TUI、无头 CLI、双 SDK |
| P02 | 连续工具结果回灌 | TUI、无头 CLI、双 SDK |
| P03 | 工具拒绝且同批次、后续步骤均为零副作用 | TUI、无头 CLI、双 SDK |
| P04 | 部分成功不能覆盖拒绝 | TUI、无头 CLI、双 SDK |
| P05 | 路径逃逸失败关闭 | 无头 CLI、双 SDK |
| P06 | 网络拒绝不能绕过 | 无头 CLI、双 SDK |
| P07 | 审批目标与风险完整展示 | TUI、无头 CLI |
| P08 | 中止与超时终态一致 | TUI、无头 CLI、双 SDK |
| P09 | checkpoint 冲突不覆盖人工修改 | TUI、无头 CLI、双 SDK |
| P10 | Session 与 RunState 稳定恢复 | TUI、无头 CLI、双 SDK |
| P11 | retry 耗尽不返回成功 | TUI、无头 CLI、双 SDK |
| P12 | verify-repair-verify 有界收敛 | TUI、无头 CLI、双 SDK |
| P13 | 无进展达到阈值后停止 | 无头 CLI、双 SDK |
| P14 | TypeScript 真实缺陷最小修复 | 无头 CLI、TypeScript SDK |
| P15 | Python 真实缺陷最小修复 | 无头 CLI、Python SDK |
| P16 | 既有脏工作区保持不变 | 无头 CLI、双 SDK |
| P17 | 凭据、正文与命令敏感值不进入 Trace/RunState | TUI、无头 CLI、双 SDK |
| P18 | npm tarball 内容与入口 | 发布物 |
| P19 | Python wheel 内容与 Worker | 发布物 |
| P20 | Windows 与 Linux 真实伪终端 | TUI |

## 1.3.0 能力复验与兼容边界

在同一候选版本、提交和实际制品上核对以下旅程；这些检查补充原 P01～P20，不能替代真实 Provider、双平台或发布后的公开回装证据：

- 标准 `SKILL.md` 先提供索引，显式 `load_skill` 交付冻结正文；冷恢复沿用原快照，不加载修改后的源文件，也不扩权。
- `/steer`、`/follow-up` 在同一 Run 内生效；五态控制回执与实际 Turn 的输入认领/完成事实分离，审批期间正文不能消费原审批。
- 本地 MCP stdio 只在权限与预算准入后启动；真实工具结果、取消、进程收尾与未知副作用保持原执行合同。
- HTTP MCP 仅访问固定目标和精确授权资源 URI；凭据不进入公开事件或 Facts，资源内容不触发任意宿主文件读取，Child Run 不继承 MCP 授权。
- 显式 OAuth 登录、取消、退出和登出保持受控；真实 loopback 回调及 socket 收尾有独立证据。本地授权服务器夹具不等于外部服务互通认证。
- Config v3 显式 `deferred` 的中英文词法发现、声明 generation 与持久选择可从权威事实重建；安装从后续请求生效，原 deny、审批与预算继续生效。
- 终端按实际 Run/Agent/Step/Call 关联审批、耗时、结果和 Effect；stored/blocked Artifact、中文合并输入、字符簇退格、粘贴留稿及退出等待均有真实入口回归，缺失结果不能变成成功。

Config v2、默认或显式 `direct` 和 Protocol v1 继续兼容；`deferred` 不自动升级旧配置。新能力须匹配 SDK 与 bundled Worker，Protocol v2 还须匹配 Schema 指纹。运行下限为 Node.js ≥ 22.19，Python SDK 为 Python ≥ 3.10；实际验证环境另按运行记录说明，不把支持下限当作本轮已经运行的版本。技能加载、工具发现和恢复均不能放宽原权限；未知效果必须先人工核对。全局成对性能收益未认证。

## 2. P20 真实伪终端

正式候选必须在 Windows 和 Linux 各启动一次由操作系统 PTY/ConPTY 承载的真实 CLI/TUI 进程，并向该进程发送真实按键。普通 CI 日志、组件渲染快照、管道 stdin 和另一平台的结果都不能替代该检查。执行：

```powershell
npm run acceptance:tty
```

CI 在两个目标平台分别执行同一命令，保存绑定版本与提交的证据 Artifact；发布工作流下载两份证据并再次校验。脚本无法启动平台伪终端、终端渲染异常或用户报告实际体验偏差时，必须回退到人工终端验收，不能跳过 P20。

每个平台必须实际确认：

1. `launch`：TUI 进入全屏交互界面。
2. `help`：帮助命令可见且不破坏输入状态。
3. `approval-deny`：拒绝第一次写入审批后不再出现同一运行的后续审批，文件没有副作用，终态为 `paused`。P03 自动锚点另行证明顺序工作流不会保存拒绝步骤输出，也不会启动后续步骤。
4. `approval-allow`：批准后文件实际写入并生成 checkpoint。
5. `abort`：生成期间可中止，中止后仍能继续对话。
6. `session-resume`：保存并重新进入后能恢复会话。
7. `checkpoint-diff-restore`：可查看 diff，并恢复到写入前状态。
8. `streaming`：真实终端持续显示模型增量输出。
9. `status`：状态命令展示当前运行事实。
10. `exit`：正常退出并返回宿主终端。
11. `control-tui`：TUI 的 `/steer` 与 `/follow-up` 在同一个 Run 内生效。
12. `control-readline`：readline 的两条控制命令在同一个 Run 内生效。
13. `control-approval-isolation`：审批期间控制正文中的 `y`、`n` 不消费原审批；只有明确批准才产生写入副作用。
14. `draft-explicit-send`：忙碌期间普通草稿保持可见，运行结束后仅在用户明确确认时发送。
15. `control-input-facts`：两个控制保持独立身份，持久化的输入认领、完成事实绑定到实际 Turn，不能用 `applied` 回执代替消费事实。

自动脚本根据对应模板生成证据：

- [Windows 模板](evidence/rc-tty-windows.example.json)
- [Linux 模板](evidence/rc-tty-linux.example.json)

现有[Windows TUI 维护者人工验收手册](WINDOWS-TUI-MAINTAINER-ACCEPTANCE.zh-CN.md)记录的是 `0.3.0-rc.2` 的历史人工体验证据。`0.3.0` 已使用精确候选产物另行完成维护者最终人工验收；后续候选仍须独立验收，历史人工结果和本节自动证据均不能互相代填。

证据保存为 `.scratch/rc-evidence/rc-tty-windows.json` 和 `.scratch/rc-evidence/rc-tty-linux.json`。`version` 与 `commit` 必须等于当前候选，`evidenceLevel` 必须为 `automated-real-tty`，全部检查必须为 `true`。`.scratch` 不进入 Git：如果把包含提交 SHA 的证据再提交进候选，会改变 SHA 并形成无法通过的自引用。发布负责人应将两份 JSON 与对应工作流运行号存入受控验收档案，不将业务内容或密钥写入证据。随后执行：

```powershell
npm run acceptance:rc -- --require-manual
```

证据绑定错误、缺少检查、JSON 损坏或任一平台未通过时，命令必须失败。

## 3. 真实 Provider

P01～P20 不代替真实 Provider 发布复验。使用已批准的数据和本机环境变量执行：

```powershell
npm run providers:certify
```

认证必须覆盖流式输出、工具调用、结构化结果、多轮会话、中止、错误映射和长上下文七项检查。账号未开通模型服务、权限不足、密钥失效或真实请求失败时停止严格认证发布；不得静默换模型、换 Provider 或把历史证据当成本次实时通过。`0.7.0` 仅接受 Issue #113 已记录、绑定运行 `33582995518` 与固定 Runtime 摘要的一次性网络超时裁决；它不更新认证台账。`0.7.1` 的简化决定单独记录在 SOP，其他版本仍适用严格规则。

## 4. 完成条件

只有以下条件同时成立，RC 才完成：

- P01～P19 自动矩阵通过且测试锚点完整。
- Windows 与 Linux 的 P20 证据绑定同一候选版本和提交。
- 至少一个真实 Provider 完成本版本、最终提交与 Runtime 摘要绑定的本次严格复验；历史例外不适用于 `1.3.0`。
- 两个平台的 CI、稳定性、覆盖率、安全和发布物门禁通过。
- 最终全仓 Markdown 审计通过。
- 固定中英 Release 正文经语义审阅，唯一 `{{RELEASE_COMMIT}}` 注入经校验的提交 SHA；创建只用 `--notes-file`，既有 body 冲突停止，不自动聚合 PR 标题或覆盖正文。

RC 完成仍不等于已经发布。Tag、npm、PyPI、GitHub Release 与文档站必须继续按[正式发布 SOP](README.zh-CN.md)执行。

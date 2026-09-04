# Release Candidate 验收指南

本指南用于验证同一候选提交上的 CLI/TUI、无头 CLI、TypeScript SDK、Python SDK 与发布物。自动测试、真实终端和真实 Provider 是三类独立证据，不能互相替代；`0.7.0` 的维护者网络例外必须单独标为 waived，不能冒充真实 Provider 成功。

> `0.3.0` 已使用本指南完成最终验收，并从提交 `dc6e45489b06f3c28da1934f063fbfbc671c05ef` [正式发布](https://github.com/Eclipseic1848/CoreMind/releases/tag/v0.3.0)。本指南继续用于后续候选，不表示后续版本已自动通过。

[English](RC-ACCEPTANCE.en.md)

> `0.7.1` 按[正式发布 SOP](README.zh-CN.md)的独立简化决定晋升固定候选：复用已通过的双平台离线验证，不重跑本指南。真实 Provider 作业在 npm 安装阶段失败、未调用模型，因此不宣称本指南的严格 RC 全部完成，也不复用 `0.7.0` 网络豁免。以下仍是取得完整严格资格的流程。

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
8. `exit`：正常退出并返回宿主终端。

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
- 至少一个真实 Provider 本次复验通过，或 `0.7.0` 的精确网络例外证据有效。
- 两个平台的 CI、稳定性、覆盖率、安全和发布物门禁通过。
- 最终全仓 Markdown 审计通过。

RC 完成仍不等于已经发布。Tag、npm、PyPI、GitHub Release 与文档站必须继续按[正式发布 SOP](README.zh-CN.md)执行。

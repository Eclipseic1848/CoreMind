# CoreMind 0.3.0-rc.2 Windows TUI 维护者人工验收手册

> 对应 Issue：#21
>
> 适用对象：维护者在 Windows Terminal 的真实 PowerShell 窗口中，亲自体验公开 npm 包 `coremind-cli@0.3.0-rc.2`。
>
> 证据边界：本文记录的是人工体验证据。自动测试、PTY/ConPTY 自动化和 Agent 预检只能补充，不能代替维护者操作与判断。

## 1. 结果规则与稳定版阻断

每个 Case 执行后只能记录以下一种结果：

- `通过`
- `失败：<简短原因>`
- `无法判断：<缺少的现象或证据>`

以下任一现象属于稳定版硬阻断，不能签字豁免：

- 主流程无法完成。
- 审批对象、允许或拒绝的含义容易被误解。
- 危险操作的错误或风险提示具有误导性。
- 界面卡死，或输入、审批、文件内容、checkpoint、Session 数据丢失。
- 拒绝后仍产生副作用、恢复结果不可信、工作区外出现写入。

轻微排版、颜色、措辞偏好和非关键快捷键问题不是自动通过项；应记录现象，由维护者另行判断是否接受。

## 2. 前置条件与安全边界

1. 使用 Windows Terminal 中独立的 PowerShell 窗口，不使用 CI、管道 stdin、编辑器 Output 面板或 `--no-tui`。
2. Node.js 必须为 `22.19.0` 或更高版本。
3. 安装会访问公开 npm Registry；其余运行只连接 `127.0.0.1:18821`，不访问真实模型服务，不产生模型费用。
4. `COREMIND_TUI_TEST_KEY` 只设置合成占位值；不要填写或粘贴任何真实 API Key。
5. 所有提示词和文件内容都是合成数据。不要输入源码、业务数据、个人信息或秘密。
6. 权限固定为 `ask`，工作区保护固定开启。审批面板不是普通确认框：只有工具为 `write`、目标为隔离目录中的 `article.md`、内容为“真实 TTY 验收”时才按 `y`；任何不一致都按 `n` 并记录失败。

准备三个 PowerShell 窗口：A 运行本地 Mock Provider，B 安装并运行 TUI，C 在 TUI 运行期间核对文件。

## 3. 创建隔离目录

在窗口 B 中从仓库根目录执行：

```powershell
$ErrorActionPreference = 'Stop'
$repoRoot = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'scripts\tty-mock-provider.mjs'))) {
  throw '请先切换到 CoreMind 仓库根目录。'
}
$acceptRoot = Join-Path $repoRoot '.scratch\issue-21\manual'
if (Test-Path -LiteralPath $acceptRoot) {
  throw "验收目录已存在，请停止并让 Agent 检查，禁止覆盖旧证据：$acceptRoot"
}
$workspaceRoot = Join-Path $acceptRoot 'workspace'
New-Item -ItemType Directory -Path $workspaceRoot | Out-Null
$fixtureRoot = Join-Path $repoRoot 'docs\release\fixtures\windows-tui-maintainer'
Copy-Item -LiteralPath (Join-Path $fixtureRoot 'package.json') -Destination $acceptRoot
Copy-Item -LiteralPath (Join-Path $fixtureRoot 'coremind.yaml') -Destination $workspaceRoot
node --version
```

预期：最后一行大于或等于 `v22.19.0`；目录位于当前仓库的 `.scratch\issue-21\manual`，没有覆盖旧目录。

## 4. M01：公开包安装

继续在窗口 B 中执行：

```powershell
Set-Location -LiteralPath $acceptRoot
npm.cmd install --ignore-scripts --no-audit --no-fund --package-lock=false --registry=https://registry.npmjs.org/
npm.cmd ls coremind-cli --depth=0
& '.\node_modules\.bin\coremind.cmd' --version
```

预期：安装退出码为 0；依赖树显示 `coremind-cli@0.3.0-rc.2`；版本输出严格为 `coremind v0.3.0-rc.2`。安装失败、版本漂移或使用了仓库源码均记为失败。

## 5. 启动本地 Provider

在窗口 A 中先切换到 CoreMind 仓库根目录，然后执行：

```powershell
$ErrorActionPreference = 'Stop'
$repoRoot = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'scripts\tty-mock-provider.mjs'))) {
  throw '请先切换到 CoreMind 仓库根目录。'
}
node '.\scripts\tty-mock-provider.mjs' 18821 --manual-paced
```

预期：窗口显示 `人工验收 Mock Provider 已监听 http://127.0.0.1:18821` 并保持运行。

在窗口 B 中验证本地健康状态并进入工作区：

```powershell
$health = Invoke-WebRequest -Uri 'http://127.0.0.1:18821/health' -UseBasicParsing
$health.StatusCode
$env:COREMIND_TUI_TEST_KEY = 'synthetic-only'
$workspaceRoot = Join-Path $acceptRoot 'workspace'
Set-Location -LiteralPath $workspaceRoot
& '..\node_modules\.bin\coremind.cmd' doctor '.\coremind.yaml'
```

预期：健康状态为 `204`；环境自检显示 Node、Runtime 兼容层、配置文件、Mock Provider 和 API key 环境变量全部正常。不要把占位环境变量或全部环境变量输出到记录中。

## 6. M02：启动、输入与流式输出

在窗口 B 中执行：

```powershell
& '..\node_modules\.bin\coremind.cmd' chat '.\coremind.yaml' --session maintainer-win-21 --permission ask
```

操作与预期：

1. 确认进入全屏 TUI，能看见标题、消息区、输入区和底部状态区。
2. 输入 `中文输入abc`，按三次 Backspace 删除 `abc`，确认中文仍完整且没有丢字或乱码。
3. 继续输入 `，记住验收口令：RC2-WIN-21`，按 Enter。
4. 回复应以 `mock流式回复：` 开头，并以可观察的逐字方式出现；界面在生成完成后恢复可输入状态。

如果看不清是否逐字出现，记录“无法判断”，不要根据自动化结果推定通过。

## 7. M03：帮助与状态

在 TUI 输入 `/help` 并按 Enter，再次输入 `/help` 并按 Enter，最后输入 `/status` 并按 Enter。

预期：帮助第一次打开、第二次关闭；命令列表包含 `/checkpoints`、`/diff`、`/restore`、`/abort` 和 `/exit`；状态可理解地显示运行终态、turn、工具次数、token、checkpoint 等摘要，且不会破坏输入状态。

## 8. M04：审批拒绝

在 TUI 输入并按 Enter：

```text
写入验收文件
```

审批面板出现后，先阅读工具、风险、影响、目标、原因和参数，然后按 `n`。

预期：审批明确表示将执行 `write`，目标为 `article.md`，参数内容为“真实 TTY 验收”；按 `n` 后运行显示暂停或拒绝，不能显示成功，也不能继续执行写入。

在窗口 C 中先切换到 CoreMind 仓库根目录，然后执行：

```powershell
$repoRoot = (Get-Location).Path
$acceptRoot = Join-Path $repoRoot '.scratch\issue-21\manual'
$workspaceRoot = Join-Path $acceptRoot 'workspace'
Test-Path -LiteralPath (Join-Path $workspaceRoot 'article.md')
```

预期：输出 `False`。若文件存在，属于稳定版硬阻断。

## 9. M05：审批允许

再次在 TUI 输入 `写入验收文件` 并按 Enter。逐项确认审批信息仍与 M04 一致后按 `y`。

预期：界面显示工具成功完成，最终回复为“工具完成”，没有重复审批或重复写入。

在窗口 C 中执行：

```powershell
$articlePath = Join-Path $workspaceRoot 'article.md'
Test-Path -LiteralPath $articlePath
Get-Content -LiteralPath $articlePath -Encoding utf8
```

预期：依次得到 `True` 和 `真实 TTY 验收`。任何额外写入、乱码或内容不一致都记为失败。

## 10. M06：状态、checkpoint、diff 与 restore

依次在 TUI 输入：

```text
/status
/checkpoints
```

从 `/checkpoints` 输出中记录 `write` 对应的 checkpoint UUID，然后输入：

```text
/diff <把这里替换为 checkpoint UUID>
/restore <把这里替换为 checkpoint UUID>
```

预期：

1. `/status` 显示工具次数和 checkpoint 数，含义清楚。
2. `/checkpoints` 显示 `write` 且标记为可恢复。
3. `/diff` 显示 `changed=true`，并能看懂 `article.md` 从不存在到包含“真实 TTY 验收”的差异。
4. `/restore` 明确显示恢复成功。

恢复后在窗口 C 中执行：

```powershell
Test-Path -LiteralPath (Join-Path $workspaceRoot 'article.md')
```

预期：输出 `False`。如果 diff 难以理解，或无法判断恢复是否对应正确 checkpoint，必须记录“无法判断”或“失败”，不能只因命令未报错而记为通过。

## 11. M07：Session 保存与恢复

在 TUI 输入 `/exit` 并按 Enter。

预期：正常回到 PowerShell，并显示会话已保存的位置。然后使用相同会话 ID 重启：

```powershell
& '..\node_modules\.bin\coremind.cmd' chat '.\coremind.yaml' --session maintainer-win-21 --permission ask
```

预期：启动时显示已恢复会话及历史消息条数；先前对话在界面中可理解。输入 `验收口令是什么？` 并按 Enter，预期逐字回复 `RC2-WIN-21`，证明恢复后的上下文实际进入请求，而不只是出现保存文件。

## 12. M08：生成中止与中止后继续

在 TUI 输入 `生成慢回复` 并按 Enter；看到忙碌或生成状态后，在 15 秒内输入 `/abort` 并按 Enter。

预期：当前运行及时显示中止，界面恢复可输入状态，不应等到“不应等到这段慢回复”。随后输入 `中止后继续` 并按 Enter，预期重新出现逐字的 `mock流式回复：中止后继续`。

无法输入 `/abort`、中止后仍输出慢回复、界面卡死或后续输入丢失都属于稳定版硬阻断。

## 13. M09：退出与清理

在 TUI 输入 `/exit` 并按 Enter。

预期：正常回到 PowerShell，终端输入和光标恢复正常，没有卡死。窗口 A 按 Ctrl+C 停止本地 Provider。

先把第 14 节结果交给 Agent 记录；在 Agent 确认结果已保存之前不要删除验收目录。确认后，窗口 B 可执行以下精确清理命令：

```powershell
$expectedRoot = Join-Path $repoRoot '.scratch\issue-21\manual'
if ($acceptRoot -ne $expectedRoot) { throw '清理路径与预期不一致，拒绝删除。' }
Remove-Item -LiteralPath $acceptRoot -Recurse -Force
Remove-Item Env:COREMIND_TUI_TEST_KEY -ErrorAction SilentlyContinue
```

该删除不可恢复，但范围仅限本次 `.scratch\issue-21\manual`。仓库源码、真实配置、用户主目录和其他 `.scratch` 目录均不在清理范围内。

## 14. 结果记录

执行人、Windows 版本、终端版本和 Node 版本由维护者亲自提供。Agent 不得根据自动化预填结果。

| 环境字段 | 维护者提供的实测值 |
|---|---|
| 日期与执行方式 | 2026-08-12，维护者亲自在真实 Windows 交互终端操作 |
| Windows | Microsoft Windows 11 Pro `10.0.26200`，64 位 |
| 终端 | Microsoft Windows Terminal `1.24.11911.0` |
| PowerShell | Windows PowerShell `5.1.26100.9168`，Desktop Edition |
| Node.js | `v22.22.1` |
| CoreMind CLI | 公开 npm 包 `coremind-cli@0.3.0-rc.2`；输出 `coremind v0.3.0-rc.2` |

| Case | 人工结果 | 观察或证据摘要 |
|---|---|---|
| M01 公开包安装 | 通过 | 维护者实测 Node `v22.22.1`；隔离目录安装 `coremind-cli@0.3.0-rc.2`；CLI 输出 `coremind v0.3.0-rc.2`。 |
| M02 启动、输入与流式输出 | 通过 | 维护者确认全屏界面、中文输入与退格、逐字流式输出以及生成后恢复输入均正常。 |
| M03 帮助与状态 | 通过 | 维护者确认帮助可正常打开和关闭，命令列表与状态摘要可读，操作后输入正常。 |
| M04 审批拒绝 | 通过 | 维护者确认审批信息清楚；拒绝后显示暂停或拒绝；外部核对 `Test-Path=False`，没有文件副作用。 |
| M05 审批允许 | 通过 | 维护者确认允许后仅出现一次审批，工具成功；`article.md` 存在且 UTF-8 内容为“真实 TTY 验收”。 |
| M06 checkpoint、diff 与 restore | 通过 | 维护者确认状态和 checkpoint 含义清楚；diff 为 `changed=true` 且可理解；restore 成功后外部核对 `Test-Path=False`。 |
| M07 Session 保存与恢复 | 通过 | 维护者确认显示会话恢复和历史数量，历史可理解；恢复后准确回复口令 `RC2-WIN-21`。 |
| M08 中止与中止后继续 | 通过 | 维护者在运行期间执行 `/abort`，运行及时中止且未出现哨兵慢回复；随后可继续输入并获得正常流式回复。 |
| M09 退出与终端恢复 | 通过 | 维护者确认 TUI 正常保存会话并退出，终端恢复正常；Mock Provider 可用 Ctrl+C 停止。 |

不要在记录或截图中包含真实密钥、完整环境变量、用户名目录、业务数据或不必要的会话正文。截图不是必需；文字记录应足以说明判断依据。

## 15. 本次结论

- 人工结果：9 项通过，0 项失败，0 项无法判断。
- 在 #21 规定的 Windows TUI 维护者旅程中，未观察到主流程阻断、审批误导、危险错误提示、卡死或输入丢失。
- 本结论来自维护者对公开 npm 包 `coremind-cli@0.3.0-rc.2` 的真实交互操作，不由自动化结果代填。
- 本结论只满足 #21 的 Windows 人工体验范围，不替代 P01～P20、Linux、真实 Provider、稳定候选和最终发布授权。

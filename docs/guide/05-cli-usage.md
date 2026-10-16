# CLI 使用指南

面向第一次用命令行工具的你：从安装到日常使用、多项目管理、常见问题排查，一次讲透。目标读者：会开终端、但对"命令行工具到底怎么用"还不太熟的人。

## 1. 安装、更新与卸载

### 前置条件：Node.js

CoreMind 需要 **Node.js ≥ 22.19.0**。先确认你装了没有：

```bash
node --version
```

- 版本不低于 `v22.19.0` → 直接进入下一步；`v22.0`～`v22.18` 仍需升级
- 提示"无法识别"→ 去 [nodejs.org](https://nodejs.org) 下载安装（选 LTS 版，一路下一步即可）

### 全局安装（推荐）

```bash
npm install -g coremind-cli@1.0.1
```

`-g` 表示**全局安装**——装一次，之后在任何目录都能用 `coremind` 命令。本文对应 `1.0.1` 发布线；安装前以 Release 或 Registry 当前列出的版本确认公开可用性。

### 验证安装成功

```bash
coremind --version        # 1.0.1 显示 coremind v1.0.1
coremind doctor           # 环境自检；检查项目密钥时传入 coremind.yaml
```

看到 `coremind v1.0.1` 表示 CLI 已安装；进入项目后再运行 `coremind doctor coremind.yaml` 检查配置和所需环境变量。`doctor` 不会向 Provider 发送真实请求。

### 更新到已验证的版本

```bash
npm view coremind-cli version     # 查询 Registry 当前版本
npm install -g coremind-cli@1.0.1 # 本文目标版本，安装前核对 Registry
```

升级到将来的版本时，先查看该版本的 Release 和迁移说明，再把安装命令中的版本号换成已验证的目标版本。

### 卸载

```bash
npm uninstall -g coremind-cli
```

### 不想安装？临时体验（不推荐日常用）

```bash
npx -y coremind-cli@1.0.1 doctor
```

npx 每次都会现场下载，速度慢、也不方便日常使用——适合"我就想先看看它是什么"的场景。

## 2. 八个命令速查

| 命令 | 用途 | 常用参数 | 例子 |
|---|---|---|---|
| `coremind create <name>` | 创建或接入项目；交互时选择 Provider，非交互时必须显式指定 | `--template <id>`、`--language <lang>`、`--provider <id>`、`--model <id>`、`--api-key-env <name>` | `coremind create . --template translator --provider alibaba-model-studio` |
| `coremind run <file>` | 运行一次智能体，或从安全边界恢复意外中断/显式暂停的运行 | `--prompt`、`--print`、`--json-events`、`--session`、`--resume`、`--max-steps`、`--permission` | `coremind run coremind.yaml --prompt "翻译：你好"` |
| `coremind chat <file>` | **交互式对话**（多轮，全屏界面） | `--session <id>`、`--permission ask\|assisted\|full` | `coremind chat coremind.yaml` |
| `coremind check [file]` | 配置、安全、文档与质量门禁 | `--profile`、`--override-reason`、`--json` | `coremind check coremind.yaml` |
| `coremind eval [file]` | 运行场景评测 | `--suite <file>`、`--permission`、`--json` | `coremind eval coremind.yaml` |
| `coremind templates` | 查看全部 8 个场景模板 | — | `coremind templates` |
| `coremind providers` | 查看可配置 Provider 与当前认证状态 | — | `coremind providers` |
| `coremind doctor [file]` | 环境自检（排查问题第一步） | 可选：配置文件路径 | `coremind doctor coremind.yaml` |

记不住？随时 `coremind help`（或 `coremind --help`）查看全部命令和参数。

`eval` 同时支持 schemaVersion 1 的文本断言和 schemaVersion 2 的多证据 grader。编码任务建议使用后者，同时验证终态、工具轨迹、测试命令、允许文件、Git 差异、运行状态和最终回答：

```powershell
coremind eval coremind.yaml --suite evals/scenarios.yaml --json
```

完整配置与可执行样例见[编码智能体指南](../modules/build-coding-agents/GUIDE.zh-CN.md)和[真实缺陷评测](../../examples/coding-evals/README.zh-CN.md)。

### run 自动化终态

`coremind run` 使用稳定退出码：`0` 成功、`1` 失败、`2` 暂停等待人工处理、`3` 预算耗尽、`124` 超时、`130` 中止。自动化应同时检查退出码和 `--json-events` 最后一条 `run_result.snapshot` 的 `outcome`、评测与发布判断，诊断信息从 stderr 保存。`run_result.observability` 与 TypeScript/Python/Worker 使用同一 Fact Projection；即使 Telemetry 为 `DISABLED`，本地 Run、Context、Call、错误和交付状态仍存在。

`--print` 的 stdout 仅输出最终正文；提示、审批与诊断走 stderr。需要结构化事件流时使用 `--json-events`，两者不能同时使用。

模型因单次输出上限结束（`stopReason: length`）时，Run 返回 `failed/model_output_limit`，退出码为 `1`。结果保留部分正文和消息中的原始停止原因，`--print` 仍输出已有部分正文；不能将其当作完整回答。Runtime 不自动续写或按瞬态错误重试，也不推进后续 Workflow 步骤或 Loop 验收。此错误与累计运行预算耗尽的 `budget_exceeded` 不同。

## 3. 在哪里运行：目录规则（新手最容易困惑的部分）

全局安装后 `coremind` 命令**任何目录都能敲**，但"在哪敲"会影响它找到什么文件。下面把规则讲透。

### 方式一：先进入项目目录，再运行（推荐）

```powershell
cd "D:\projects\my-agent"          # 进入项目目录
coremind run coremind.yaml --prompt "你好"
coremind chat coremind.yaml        # 或者开对话
```

这是**最不容易出错**的方式——所有文件都在眼前，配置相对路径、.env、输出文件都在同一个目录。

### 方式二：不切换目录，直接给配置文件路径

```powershell
coremind run "D:\projects\my-agent\coremind.yaml" --prompt "你好"
coremind run my-agent/coremind.yaml --prompt "你好"    # 相对路径也行
```

适合"我就在这，偶尔跑一下别的项目"的场景。

### 方式三：从任意目录跑任意项目

命令是全局的，配置文件路径是任意的，两者可以自由组合：

```powershell
cd "D:\projects"
coremind run agent-a/coremind.yaml --prompt "任务1"
coremind chat agent-b/coremind.yaml
```

### 两条铁律（决定了所有坑）

| 路径类型 | 解析基准 | 举例 |
|---|---|---|
| 配置里的相对路径（自定义工具 `./my-tool.mjs`、`skills/` 目录、`session.dir`） | **配置文件所在目录** | 配置文件在 `D:\a\coremind.yaml`，`skills/` 就在 `D:\a\skills/` |
| `.env`、内置文件工具与 bash 的工作目录 | **当前终端所在目录（cwd）** | 你在 `D:\b` 敲命令，`.env` 就找 `D:\b\.env`；内置文件工具也以 `D:\b` 为工作区 |

含义：**用方式一（cd 进项目）时所有规则自动对齐**——这也是为什么推荐方式一。

> 注意：`.env` 跟随"敲命令的目录"，不是配置文件目录。如果你从别的目录跑一个项目，它的 `.env` 不会生效，需要 cd 进去或者改用环境变量（见下一节）。

## 4. API key 管理

模型提供商需要密钥（API key）才能调用。以本指南的百炼示例为例，CLI 按以下顺序找 `DASHSCOPE_API_KEY`：

1. **系统/终端环境变量**（最高优先）
2. **当前工作目录下的 `.env` 文件**（推荐先进入项目目录）
3. 都不存在 → 运行时报错提示缺少 key

### 方式一：.env 文件（推荐）

创建项目后，项目里会有一个 `.env.example`（模板样例）。复制一份并填入你的 key：

```powershell
cd "D:\projects\my-agent"
Copy-Item .env.example .env     # Linux 用：cp .env.example .env
# 用记事本/编辑器打开 .env，填写 DASHSCOPE_API_KEY
```

**CoreMind 启动时会自动读取当前目录下的 `.env`**——不用额外设置什么，直接运行即可：

```powershell
coremind run coremind.yaml --prompt "你好"
```

`.env` 长这样：

```
# 每个提供商一行：KEY 名=你的密钥
DASHSCOPE_API_KEY=<你的密钥>
```

**三个提醒**：
- `.env` 文件名**以点开头**——Windows 资源管理器默认隐藏点开头文件，在编辑器里打开即可
- `.env` 含密钥，**不要提交到 git**（模板已自动配好 `.gitignore` 忽略它）
- 如果终端里已经设置了同名环境变量，`.env` **不会覆盖**它（环境变量优先）

### 方式二：临时环境变量（只对当前终端窗口有效）

每次打开新终端都要重新设置，关掉窗口就没了：

PowerShell：

```powershell
$env:DASHSCOPE_API_KEY = "你的真实密钥"
```

Windows cmd：

```bat
set "DASHSCOPE_API_KEY=你的真实密钥"
```

Linux Bash：

```bash
export DASHSCOPE_API_KEY="你的真实密钥"
```

### 方式三：永久环境变量（系统级）

Windows：设置 → 系统 → 关于 → 高级系统设置 → 环境变量 → 新建 `DASHSCOPE_API_KEY`。设置后**需要重新打开终端**才生效。适合"就一个项目、一个 key"的用户。

### 不确定 key 配好没有？

```powershell
coremind doctor
```

不传配置文件时，它会概览常见 key；传入 `coremind.yaml` 时，它只检查该配置声明的 `provider.apiKeyEnv`（以及受支持入口的默认变量），不会要求无关 Provider 的密钥。两种方式都只检查存在性，不验证有效性。

## 5. chat 全屏 TUI：交互式对话

`coremind chat` 会进入一个**全屏交互界面**：

```powershell
coremind chat coremind.yaml
```

### 界面布局

```
┌──────────────────────────────────────┐
│ CoreMind · my-agent   /help 查看命令  │  ← 顶部标题栏
├──────────────────────────────────────┤
│ 你 > 帮我写个周报模板                  │  ← 消息区（你的问题 + agent 的回答）
│ [assistant]                          │
│ 本周工作：...                        │
│ ↻ Loop: verifying · 迭代 2/3         │  ← 显式 Loop 当前状态
│ ⚙ read ✓  ⚙ grep ✓  ⚙ write ✓       │  ← 工具调用实时状态（…运行中 / ✓成功 / ✗失败）
│ …                                    │
├──────────────────────────────────────┤
│ 你 > [在这里输入]                     │  ← 底部输入框
└──────────────────────────────────────┘
```

### 基本操作

| 操作 | 方法 |
|---|---|
| 发送消息 | 输入内容后按**回车** |
| 删除字符 | **退格键** |
| 查看命令帮助 | 输入 `/help`（再输一次关闭） |
| 查看本轮预算/质量 | 输入 `/status` |
| 展开 Child Run tree | 输入 `/children` |
| 查看 Artifact | 输入 `/artifacts` |
| 查看 Context 预算与压缩 | 输入 `/context` |
| 查看本地观测与 Telemetry 状态 | 输入 `/observability` |
| 查看检查点 | 输入 `/checkpoints` |
| 查看变更 | 输入 `/diff <checkpointId>` |
| 显式恢复文件 | 输入 `/restore <checkpointId>` |
| 中止当前回答 | 输入 `/abort`（停止生成，可继续提问） |
| 运行中追加指令 | 输入 `/steer 文本`（1.1 开发线） |
| 自然停止后继续输入 | 输入 `/follow-up 文本`（1.1 开发线，同一 Run） |
| 退出对话 | 输入 `/exit`（已启用 session 并使用 `--session <id>` 时，下次可恢复） |

### 运行中控制与忙时草稿（1.1 开发线）

TUI 和 `--no-tui` 的 readline 均支持 `/steer 文本` 与 `/follow-up 文本`。前者在后续可用 Turn 介入，后者等当前 Agent 自然停止后继续；都不新开并发 Run，不修改本轮权限、Provider 或预算。缺少文本只显示用法。未启动、控制收件箱尚未就绪或已封口时会拒绝，不把输入留给下一 Run。

工具审批期间，readline 会先识别这两个显式命令；TUI 输入 `/` 进入独立命令模式，Enter 提交，Esc 返回审批。命令正文里的 y/n 不会批准工具，控制也不代替审批；普通审批仍用 y 允许、n/Enter/Esc 拒绝。非 TTY 审批仍安全拒绝，full 模式也不取消既有 deny 等边界。独立宿主验收等待期间，追加输入会被拒绝，避免改变待验收候选。

忙时普通文字只保留为**一份草稿**，不会自动执行或变成控制。TUI 保留可编辑输入框，忙时 Enter 不发送，空闲后再次 Enter 确认；readline 保留第一份忙时提交，后续提交明确提示未保存，不覆盖原稿。空闲后，TTY 可预填原稿供编辑并按 Enter 确认；未预填时用空行确认原稿。控制回执迟到只显示其原 Run/controlId，不清除后来输入的新草稿。

控制回执有 `accepted`、`applied`、`rejected`、`duplicate`、`conflict` 五态：`accepted` 表示已持久接收，`applied` 表示应用事实提交后已交付 Agent 队列；两者都不代表模型已消费。界面另显 `input_receipt`、`input_claimed`、`input_completed`、`input_discarded` 的输入身份与状态；最终业务结果仍看 Run outcome。

默认运行摘要会显示 Child Run 数量、活动后代与未处置风险；运行中也可输入 `/children` 查询当前 canonical Facts。`/children` 只读取统一 Fact Projection，按父子层级展开目标、身份、预算、状态、Outcome、Recovery 和风险正文；它不会读取 Runtime 内部 Map，也不会提供独立 spawn/list/resume/detach。委派审批卡会优先显示目标、任务摘要、显式引用和本次收紧预算，并明确委派批准只允许创建 Child Run，子级工具与外部副作用仍需独立审批。当前可用的取消 authority 是 `/abort`：它中止父级当前回答，并由 Runtime 将取消传播到活动 Child Run；当前 Runtime 未授权的子级独立取消或失败处置控制不会显示或伪造执行。

普通审批卡片会显示副作用、完整路径或 URL、风险原因和脱敏后的参数。工具执行还会记录 started/committed/unknown Effect Receipt。恢复 checkpoint 时若文件在工具完成后又被修改，命令会报告冲突并保留当前内容，不会静默覆盖。

1.1 开发线的工具行按本次 Run、Agent、可选 Step 和 callId 关联；同名、同参数或同参数指纹不能代替调用身份。审批请求可携带 callId/stepId，审批结果仍按 Run 与 approvalId 回连。旧请求缺少身份时只显示独立审批记录，并明确未绑定工具调用。等待审批、拒绝、执行阶段、结果和副作用状态分别展示；缺少执行耗时时显示“未记录”，本地观察等待不当作执行耗时，Run 结束也不把缺失的工具结果自动标为成功或取消。

`ChatSession.onEvent` 的可选第二参数复用原 Trace 来源，保留事件自身的 Run、eventId 和 sequence；旧单参数监听器可继续使用，缺少来源时不推断所属 Run。

Artifact 仅展示真实 stored/blocked 状态与受控引用；blocked 项不提供可打开路径，界面不会读取或打开任意输出路径。加载 Skill 说明不改变权限；工具发现的准备摘要与实际 Provider 请求使用的目录摘要分开显示，目录安装仍从后续请求生效，执行继续经过原审批。

`/observability` 显示本地观测开关、Run/Call 耗时、Telemetry mode、脱敏 endpoint origin、内容级别、允许字段、持久授权范围、Exporter 是否装载，以及 queued/handed-off/failed/dropped。`handed-off` 只表示已交给 Exporter，不表示接收端已经保存；默认 `DISABLED` 不读取外传凭据或构造 Exporter。

### 从任意目录启动

```powershell
coremind chat "D:\projects\my-agent\coremind.yaml"
```

### 非交互终端环境（管道/脚本）

当标准输入不是终端（比如在脚本里、管道传入）时，全屏界面不可用，会自动回退到普通单行输入模式。需要审批的工具在非 TTY 环境默认拒绝；可信 CI 应显式配置 allow，或明确传入 `--permission full`，且 full 仍保留 deny、工作区保护、审计、checkpoint、Effect Receipt 和恢复检查。想强制用单行模式：`coremind chat coremind.yaml --no-tui`。

Windows 宿主 Shell 不提供工作区或网络隔离。只有 `--permission full`、`workspaceOnly: false`、`network: allow` 三项同时满足时 Shell 请求才会执行；其他组合会被拒绝。发现 Git Bash 只提升命令兼容性，不改变安全边界；需要约束时请使用文件工具或隔离的 Linux 环境。

### 断点续聊：这次聊完，下次接着聊

先在 `coremind.yaml` 中启用会话：

```yaml
session:
  enabled: true
  dir: ./sessions
```

再传入会话 ID：

```powershell
coremind chat coremind.yaml --session work-1     # 第一次：保存为 work-1
coremind chat coremind.yaml --session work-1     # 第二次：自动恢复历史对话
```

`run` 命令同样支持 `--session <id>`，跨命令共享会话历史。未设置 `session.enabled: true` 时，CLI 会明确失败并提示配置，不会静默忽略会话 ID。

## 6. run 意外中断与 Loop 暂停恢复

如果进程被断电、崩溃、强制结束，或显式 Loop 以 `paused` 暂停，可以使用同一 runId 继续：

```powershell
coremind run coremind.yaml --resume <runId>
```

通常不要再次传 `--prompt`，Runtime 会使用原始输入；如果传入，内容必须与原输入完全一致。恢复会延续原 runId、Trace sequence、预算、重试计数和 Loop 快照，并直接复用已经完整持久化的 Workflow/Loop 步骤输出。

以下情况是有意拒绝，不是命令故障：运行已经正常结束、配置发生变化、RunState 损坏或断序、输入不同，或者未完成步骤留下 `started`/`unknown` 副作用。CoreMind 的恢复边界是可验证的稳定业务状态；`committed` 副作用不会自动重放，未知副作用必须先由人工核对。

1.1 开发线的控制恢复仍使用上述安全门：仅 `accepted` 的持久控制在 Agent 就绪后按原身份应用；已 `applied` 但没有确认消费事实的控制不自动重投，而明确记为 `input_discarded`。这保留了持久提交与内存投递之间的崩溃窗口，不承诺绝对 exactly-once。暂停的原输入仍可恢复，普通原输入已经 discarded 时仍拒绝恢复；控制的 discarded 不会把原本可恢复的暂停 Run 一并作废。控制事实不代替 Session 正文，也不扩大完整对话的重建范围。

## 7. 多项目工作流

每个人可以在同一台机器上维护多个项目，互不干扰。推荐目录结构：

```
D:\projects\
├── agent-a\          # 项目 A：翻译助手
│   ├── coremind.yaml
│   ├── .env          # 只放 A 的 key（如果 A 用独立 key）
│   └── skills\       # A 的自定义技能
├── agent-b\          # 项目 B：周报生成器（用同一个 key 就不用建 .env）
│   ├── coremind.yaml
│   └── sessions\     # B 的会话记录（自动生成）
└── agent-c\
    └── ...
```

切换项目就是换个目录：

```powershell
Set-Location "D:\projects\agent-a"
coremind chat coremind.yaml
Set-Location "D:\projects\agent-b"
coremind run coremind.yaml --prompt "本周干了什么"
```

每个项目独立的：配置文件、.env、技能、会话记录，全部互不污染。

## 8. 常见问题排查

| 现象 | 原因与解决 |
|---|---|
| `coremind 无法识别` / `command not found` | 没装成功。确认 Registry 已公开目标版本后运行 `npm install -g coremind-cli@1.0.1`；装了还不行 → 重开终端（PATH 刷新）；Windows 上检查 npm 全局目录是否在 PATH |
| 提示缺少 API key | ① 本例检查 `.env` 中的 `DASHSCOPE_API_KEY`（其他 Provider 以其配置中的 `apiKeyEnv` 为准）；② `.env` 不在**你敲命令的目录**（见 3 节）；③ 终端已有旧环境变量覆盖了 `.env`（dotenv 不覆盖已有变量） |
| 配置文件读不到 / 报 ENOENT | 路径写错；`coremind run coremind.yaml` 需要文件就在当前目录（或用绝对路径） |
| 运行很久没反应 / 超时 | 查看运行事件与 `runTimeoutMs`、`stepTimeoutMs`、Provider 和工具状态；`doctor` 只检查密钥存在，不验证 Provider 连接，不要在副作用结果未知时盲目重试 |
| chat 没有全屏界面 | 环境不是 TTY（如某些终端模拟器/脚本管道），自动回退单行模式，属正常 |
| 怎么知道 key 配好没有 | `coremind doctor`——所有环境类问题先跑它 |
| 上次对话丢了 | 先确认 `session.enabled: true` 且使用相同 `--session <id>`；未指定 id 的临时对话不能按该 id 恢复 |

## 9. 效率技巧

### 固定常用目录（PowerShell）

每次打开终端自动进入项目目录——编辑配置文件 `notepad $PROFILE`，加一行保存：

```powershell
Set-Location "D:\projects\my-agent"
```

### 一键开聊（PowerShell 函数）

在 `$PROFILE` 里加：

```powershell
function cm { coremind chat coremind.yaml }
```

之后在项目目录里输入 `cm` 就直接进入对话。

### 记住：help 永远在

```powershell
coremind help          # 全部命令和参数
coremind doctor        # 环境哪里不对，先跑它
```

## 下一步

- 想改配置（人设/模型/工具）？→ [配置指南](02-configuration.md)
- 想让 agent 更专业？→ [技能指南](03-skills.md)
- 跑完不知道好不好？→ [质量与调优](04-quality.md)

当前源码修复（尚未发布）：`run --print` 的 stdout 仅包含最终正文；不输出工具进度、恢复会话和保存提示，审批提示及错误诊断使用 stderr。此规则不放宽工具审批。Git 相关工具要求 Git 2.36 或更高版本。

### 管道输出交付限制

`run` 和 readline chat 的应用输出使用有界交付队列：已编码 UTF-8 的队列与在飞消息合计最多 **64 MiB、1024 条**，单条也不能超过 64 MiB；正常结束等待 write 回调，返回 false 时还必须等到 drain。最终 flush 最多等待 **10 秒**。这些是传输限制，不能当成 Runtime token 预算、总内存上限或完整的模型流背压；JSON 编码本身、外部 Writable 缓冲、Ink 全屏渲染和 readline 的 TTY 编辑回显不属于此队列。

CLI 不丢正文、控制回执或最终结果。超限、断管、输出流错误或 flush 超时锁存 `output_delivery_failed`，请求中止活动运行并等待原有收尾；命令以 `1` 结束，不能把交付失败当成用户取消的 `130`。正常背压期间 readline 仍处理 `/abort` 和审批输入；硬预算耗尽后无法承诺再交付回执。只有交付成功的 `--json-events` 才保证最后一条是 `run_result`；缺少或不完整的最终记录不能视为成功。传输失败不改写已持久化的 Run Fact，也不自动重跑可能有副作用的任务。

上述10秒限制交付等待，不保证强制终止物理流或不合作的 JavaScript。逻辑 close 有界返回；尚未返回的自有 write 仅保留一个 error 护栏及其 close 清理监听，直到该回调或流 close 收敛。超时失败不等于全部操作已静止；未确认收尾时不能据此释放或复用相关环境。

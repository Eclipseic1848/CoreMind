# CLI 使用指南

面向第一次用命令行工具的你：从安装到日常使用、多项目管理、常见问题排查，一次讲透。目标读者：会开终端、但对"命令行工具到底怎么用"还不太熟的人。

## 1. 安装、更新与卸载

### 前置条件：Node.js

CoreMind 需要 **Node.js ≥ 22.19**。先确认你装了没有：

```bash
node --version
```

- 能显示 `v22.x.x` 以上 → 直接进入下一步
- 提示"无法识别"→ 去 [nodejs.org](https://nodejs.org) 下载安装（选 LTS 版，一路下一步即可）

### 全局安装（推荐）

```bash
npm install -g coremind-cli@next
```

`-g` 表示**全局安装**——装一次，之后在任何目录都能用 `coremind` 命令。`@next` 固定安装当前预发布线。

### 验证安装成功

```bash
coremind --version        # 例如显示 coremind v0.2.0-rc.1
coremind doctor           # 环境自检：Node 版本 / API key 是否就位
```

看到版本号或"全部正常 ✅"就说明装好了。

### 更新到最新版

```bash
npm update -g coremind-cli
```

### 卸载

```bash
npm uninstall -g coremind-cli
```

### 不想安装？临时体验（不推荐日常用）

```bash
npx -y coremind-cli@next doctor
```

npx 每次都会现场下载，速度慢、也不方便日常使用——适合"我就想先看看它是什么"的场景。

## 2. 七个命令速查

| 命令 | 用途 | 常用参数 | 例子 |
|---|---|---|---|
| `coremind create <name>` | 创建或接入项目 | `--template <id>`、`--language <lang>` | `coremind create . --template translator` |
| `coremind run <file>` | 运行一次智能体，或从安全边界恢复意外中断/显式暂停的运行 | `--prompt`、`--print`、`--json-events`、`--session`、`--resume`、`--max-steps`、`--permission` | `coremind run coremind.yaml --prompt "翻译：你好"` |
| `coremind chat <file>` | **交互式对话**（多轮，全屏界面） | `--session <id>`、`--permission ask\|assisted\|full` | `coremind chat coremind.yaml` |
| `coremind check [file]` | 配置、安全、文档与质量门禁 | `--profile`、`--override-reason`、`--json` | `coremind check coremind.yaml` |
| `coremind eval [file]` | 运行场景评测 | `--suite <file>`、`--permission`、`--json` | `coremind eval coremind.yaml` |
| `coremind templates` | 查看全部 8 个场景模板 | — | `coremind templates` |
| `coremind doctor [file]` | 环境自检（排查问题第一步） | 可选：配置文件路径 | `coremind doctor coremind.yaml` |

记不住？随时 `coremind help`（或 `coremind --help`）查看全部命令和参数。

`eval` 同时支持 schemaVersion 1 的文本断言和 schemaVersion 2 的多证据 grader。编码任务建议使用后者，同时验证终态、工具轨迹、测试命令、允许文件、Git 差异、运行状态和最终回答：

```powershell
coremind eval coremind.yaml --suite evals/scenarios.yaml --json
```

完整配置与可执行样例见[编码智能体指南](../modules/build-coding-agents/GUIDE.zh-CN.md)和[真实缺陷评测](../../examples/coding-evals/README.zh-CN.md)。

### run 自动化终态

`coremind run` 使用稳定退出码：`0` 成功、`1` 失败、`2` 暂停等待人工处理、`3` 预算耗尽、`124` 超时、`130` 中止。自动化应同时检查退出码和 `--json-events` 的最后一条 `run_result`，诊断信息从 stderr 保存。

`--print` 用于普通文本管道，`--json-events` 用于 JSONL 自动化，两者不能同时使用。

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
| `.env` 文件、bash 工具的工作目录 | **当前终端所在目录（cwd）** | 你在 `D:\b` 敲命令，`.env` 就找 `D:\b\.env` |

含义：**用方式一（cd 进项目）时所有规则自动对齐**——这也是为什么推荐方式一。

> 注意：`.env` 跟随"敲命令的目录"，不是配置文件目录。如果你从别的目录跑一个项目，它的 `.env` 不会生效，需要 cd 进去或者改用环境变量（见下一节）。

## 4. API key 管理

模型提供商需要密钥（API key）才能调用。CoreMind 从三个地方找 key，按优先级：

1. **系统/终端环境变量**（最高优先）
2. **项目目录下的 `.env` 文件**（推荐新手）
3. 都不存在 → 运行时报错提示缺少 key

### 方式一：.env 文件（推荐）

创建项目后，项目里会有一个 `.env.example`（模板样例）。复制一份并填入你的 key：

```powershell
cd "D:\projects\my-agent"
copy .env.example .env          # macOS/Linux 用：cp .env.example .env
# 用记事本/编辑器打开 .env，把 DEEPSEEK_API_KEY= 后面填上你的 key
```

**CoreMind 启动时会自动读取当前目录下的 `.env`**——不用额外设置什么，直接运行即可：

```powershell
coremind run coremind.yaml --prompt "你好"
```

`.env` 长这样：

```
# 每个提供商一行：KEY 名=你的密钥
DEEPSEEK_API_KEY=sk-xxxxxxxx
```

**三个提醒**：
- `.env` 文件名**以点开头**——Windows 资源管理器默认隐藏点开头文件，在编辑器里打开即可
- `.env` 含密钥，**不要提交到 git**（模板已自动配好 `.gitignore` 忽略它）
- 如果终端里已经设置了同名环境变量，`.env` **不会覆盖**它（环境变量优先）

### 方式二：临时环境变量（只对当前终端窗口有效）

每次打开新终端都要重新设置，关掉窗口就没了：

```powershell
# PowerShell（Windows 默认）
$env:DEEPSEEK_API_KEY = "sk-xxxxxxxx"

# cmd（老式命令提示符）
set DEEPSEEK_API_KEY=sk-xxxxxxxx

# bash / zsh（macOS、Linux、Git Bash）
export DEEPSEEK_API_KEY="sk-xxxxxxxx"
```

### 方式三：永久环境变量（系统级）

Windows：设置 → 系统 → 关于 → 高级系统设置 → 环境变量 → 新建 `DEEPSEEK_API_KEY`。设置后**需要重新打开终端**才生效。适合"就一个项目、一个 key"的用户。

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
| 查看检查点 | 输入 `/checkpoints` |
| 查看变更 | 输入 `/diff <checkpointId>` |
| 显式恢复文件 | 输入 `/restore <checkpointId>` |
| 中止当前回答 | 输入 `/abort`（停止生成，可继续提问） |
| 退出对话 | 输入 `/exit`（**退出时自动保存会话**，下次可恢复） |

审批卡片会显示副作用、完整路径或 URL、风险原因和脱敏后的参数。工具执行还会记录 started/committed/unknown Effect Receipt。恢复 checkpoint 时若文件在工具完成后又被修改，命令会报告冲突并保留当前内容，不会静默覆盖。

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
cd "D:\projects\agent-a" && coremind chat coremind.yaml
cd "D:\projects\agent-b" && coremind run coremind.yaml --prompt "本周干了什么"
```

每个项目独立的：配置文件、.env、技能、会话记录，全部互不污染。

## 8. 常见问题排查

| 现象 | 原因与解决 |
|---|---|
| `coremind 无法识别` / `command not found` | 没装成功。先 `npm install -g coremind-cli@next`；装了还不行 → 重开终端（PATH 刷新）；Windows 上检查 npm 全局目录是否在 PATH |
| 提示缺少 API key | ① `.env` 没填或填错（检查变量名是否 `DEEPSEEK_API_KEY`、等号后无空格）；② `.env` 不在**你敲命令的目录**（见 3 节铁律）；③ 终端已有旧环境变量覆盖了 `.env`（dotenv 不覆盖已有变量） |
| 配置文件读不到 / 报 ENOENT | 路径写错；`coremind run coremind.yaml` 需要文件就在当前目录（或用绝对路径） |
| 运行很久没反应 / 超时 | 模型服务慢或网络问题；步骤超时上限是 5 分钟，重试一次；用 `coremind doctor` 确认 key 存在 |
| chat 没有全屏界面 | 环境不是 TTY（如某些终端模拟器/脚本管道），自动回退单行模式，属正常 |
| 怎么知道 key 配好没有 | `coremind doctor`——所有环境类问题先跑它 |
| 上次对话丢了 | chat 退出时会自动保存；`--session <id>` 再运行可恢复；没给 id 的临时会话不会保留 |

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

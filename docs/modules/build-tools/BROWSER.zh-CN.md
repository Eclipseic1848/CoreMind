# 可选浏览器工具

图谱 07.04 要求读取网页状态、执行获准的操作、收集结果并能中止。网页操作采用 Microsoft Playwright MCP，依托 CoreMind 已有的本地 stdio MCP、工具准入和进程回收。程序与命令执行使用本模块的 `ProcessRunner` 与既有沙箱。

## 运行本地示例

准备 CoreMind 源码、Node.js 22.19 或更高版本，以及独立安装的 Google Chrome。Windows 在仓库根目录运行下面的命令。Linux 将最后一个参数改为 Chrome 可执行文件的绝对路径。示例固定 `@playwright/mcp@0.0.81`，其 `playwright` 和 `playwright-core` 均为 `1.64.0-alpha-2026-09-14`。[Playwright MCP 0.0.81 发布说明](https://github.com/microsoft/playwright-mcp/releases/tag/v0.0.81)

```powershell
npm run build
npm install --prefix .scratch/p2/browser-toolchain-81 --cache .scratch/p2/browser-toolchain-81/npm-cache --ignore-scripts --no-save --package-lock=false '@playwright/mcp@0.0.81'
node examples/modules/build-tools/browser/run.mjs .scratch/p2/browser-toolchain-81/node_modules/@playwright/mcp/package.json 'C:/Program Files/Google/Chrome/Application/chrome.exe'
```

示例绑定随机分配的 `127.0.0.1` 端口，使用确定性本地模型夹具。Chrome 打开合成报表、输入月份、筛选、核对页面与截图并下载合成 CSV。接着验证审批拒绝时页面收不到请求、取消时在途页面连接关闭，以及该次 MCP 和它直接启动的 Chrome 进程退出。可提供第三个参数，指向一个已存在的证据目录，用于保存 `filtered.png`、`report.csv` 和 `browser-result.json`。

## 接到业务项目

1. 按[示例的 MCP 配置](../../../examples/modules/build-tools/browser/run.mjs)填入 `transport: stdio`、Node 和经核验的 `@playwright/mcp` 入口绝对路径，指定独立工作与输出目录。按环境选定浏览器可执行文件，启用 `--isolated`、`--headless`、`--sandbox`。无头模式从独立浏览器上下文开始，避免使用用户登录态。
2. 只为目标 Agent 逐项声明经过审查的工具。能够导航、点击、下载或写截图的浏览器会话按 `external`、`reversible: false`、`replay: unknown` 和 `durability: critical` 处理。示例明确启用 `mode: ask`、`workspaceOnly: false` 和 `network: allow`，用于受信 stdio 宿主和逐项操作审批。项目可按自己的隔离边界部署独立浏览器宿主。
3. 只让浏览器访问业务负责人授权的页面。`--allowed-origins` 能发现部分意外访问，跳转和网络隔离仍需在浏览器宿主层实施。浏览器上下文隔离控制会话状态。需要约束网络出口或宿主文件访问时，使用进程、容器或防火墙策略。[Playwright MCP 配置边界](https://playwright.dev/mcp/configuration/options)
4. 审批核对页面地址、动作和数据范围。确认筛选后页面内容、下载记录或文件字节。断开后先核对业务系统真实状态，再决定能否重试已有副作用的动作。保留 RunOutcome、Trace 和经过核查的输出证据。

`0.0.82` 和 `0.0.86` 在首次导航后实测会通知目录变化，即使关闭 WebMCP。CoreMind 随即停止使用旧目录，因此多步示例固定使用 `0.0.81`。升级时先复验首次导航后的目录和后续操作。

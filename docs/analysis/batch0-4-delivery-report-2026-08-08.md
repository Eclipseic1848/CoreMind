# CoreMind Batch 0～4 交付验收报告

日期：2026-08-08
范围：`docs/coremind-iteration-plan-2026-08-31.md` 中的 Batch 0、1、2、3、4
结论：五个批次的源码、自动测试、双语知识材料和本地打包验证已完成；这不等于 Release Candidate 或生产就绪。

## 1. 验收口径

本报告把以下状态分开：

- **已实现**：代码与公共接口存在。
- **已自动验证**：本机离线测试、类型、格式、合同或打包检查已通过。
- **待平台/外部验证**：需要 Linux runner、真实 Provider 密钥或人工 TUI 的项目，保留为后续 RC 门禁。
- **发布阻塞**：不影响 Batch 0～4 源码交付，但在公开发布前必须关闭。

没有把流畅输出、一次 mock 成功或 dry-run 当成生产证明。

## 2. 批次结果

| 批次 | 已交付 | 主要证据 | 状态 |
|---|---|---|---|
| Batch 0 | 失败不再伪装成功；工具统计接入；ChatSession 只返回本轮；会话损坏明确失败；警告清零 | Runtime、ChatSession、Session、Provider 与 CLI 回归测试 | 已实现并离线验证 |
| Batch 1 | Config v2；Protocol v1；统一事件/错误/审批协议；`coremind-ai` 公共门面；可重复构建 | Config/Protocol/facade 契约测试；220 个构建文件连续两次 SHA-256 零差异 | 已实现并离线验证 |
| Batch 2 | RunOutcome/RunMetrics；多维预算；三档权限；Tool Policy；Trace；append-only RunState；checkpoint/diff/restore；Context 保护；稳定步骤边界恢复 | Runtime、预算、策略、RunState、checkpoint、Context、恢复失败注入测试 | 已实现并离线验证 |
| Batch 3 | Python 同步/异步 SDK；常驻 Node worker；stdio JSON-RPC；Python callable 工具；双 SDK 结果/事件契约；`resume_run` | 6 项 Python SDK/真实 worker 测试；临时虚拟环境 wheel 离线安装后 SDK 6/6、黄金示例 2/2 通过 | 已实现并离线验证 |
| Batch 4 | CLI/TUI；create/check/eval；审批队列；质量门禁与覆盖审计；4 个黄金示例；16 个模块合同；项目级中英文材料生成；Windows/Linux CI | CLI E2E 23/23；模块合同；16 个 Skill 校验；4 个黄金示例自动测试 | 已实现并离线验证 |

## 3. Harness 与恢复边界

### 已实现

- turn、step、工具调用、工具失败、重试、token、费用、步骤超时和总运行超时预算。
- 用户取消与明确的错误码。
- Provider 调用前按完整 turn 做确定性 Context 保护。
- 每条 Trace 包含 `runId`、`eventId`、递增 `sequence` 和 `timestamp`。
- 每个工具调用事件包含幂等关联标识。
- Workflow 完整步骤输出以 `step_output` 持久化；意外中断后可用 CLI、TypeScript 或 Python 从稳定边界继续。

### 明确不承诺

- 不恢复任意 JavaScript/Python 调用栈。
- 不自动重放已启动的非重放安全工具。
- 不提供通用“恰好一次”副作用保证；订单、支付、发信等工具仍需业务持久层收据或去重。
- 已结束运行、配置/输入不一致、RunState 损坏或未完成步骤含不安全副作用时，恢复会明确拒绝。

## 4. 权限与平台边界

- `ask`：需要批准的操作逐项询问。
- `assisted`：路径感知的工作区内低风险操作可自动批准，高风险操作询问。
- `full`：不逐项询问，但显式 deny、审计、Trace 和 checkpoint 不关闭。
- 路径感知文件工具执行工作区策略；shell 与自定义工具不能被描述成同等可恢复。
- Linux 内置 `bash` 使用 OS 级沙箱，固定断网、只允许写工作区，并在沙箱初始化失败时关闭执行。
- Windows 一期没有 OS 级 shell 沙箱，shell 仍属于不可逆高风险能力。

Linux 实现锁定 [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) `0.0.71` 并依赖 [Bubblewrap](https://github.com/containers/bubblewrap)。前者仍是上游研究预览版，因此不能作为生产成熟度或 Claude Code 等价性的证据。

Ubuntu/Debian 还需要 `socat` 与 `ripgrep`。Ubuntu 24.04 及以后默认的 AppArmor 非特权用户命名空间限制会阻止隔离启动；CI 只在临时 runner 中关闭该限制，生产主机必须由系统安全负责人单独评估，框架不会自动修改系统安全设置。

## 5. 知识交付

16 个能力模块均具备：

- `module.yaml`
- 中英文 README
- 中英文 SOP
- 中英文开发指南
- 通用 `SKILL.md` 与 `agents/openai.yaml`
- 中英文模块示例
- 实现和测试路径
- CHANGELOG

四个黄金示例均具备离线数据、配置、实现、测试、评测、项目 Skill、失败指导，以及中英文需求/架构/SOP/测试/验收材料。

文档门禁还会扫描所有 CoreMind 自有 Markdown，阻止被禁止的底层运行库品牌标识重新进入用户材料。第三方安装目录不在修改范围内。

## 6. 验证结果

已通过：

```text
npm run build
npm run check
npm test
npm run build:python-worker
python -m unittest discover -s python/tests -p "test_*.py" -v
python -m unittest discover -s examples/golden/python-data-analysis/tests -p "test_*.py" -v
python -m build --wheel python
npm publish --dry-run --workspaces --if-present
git diff --check
```

关键结果：

- Node：29 个测试文件通过，195 项通过。
- 条件跳过：2 项 Linux 沙箱集成测试、2 项真实 Provider 测试；原因已知，不算对应能力已验收。
- Python：SDK/worker 6/6；Python 黄金示例 2/2。
- wheel：12 个预期文件，约 3.33 MB；包含 worker；无测试目录、缓存、本地绝对路径或错误许可元数据；全新虚拟环境离线安装复测 8/8 通过。
- npm：8 个公开 workspace dry-run 成功；私有 Web 原型按设计跳过。
- 模块：16/16 合同通过，4/4 黄金示例登记完整，16/16 Skill 通过格式校验。
- 构建：220 个 `dist` 文件连续两次构建哈希一致；孤儿产物会在构建前清理。
- 文档品牌边界：项目自有 Markdown 的底层 Agent 实现品牌命中数为 0；生成器和 `check:modules` 已设置持久阻断，防止重新生成时回流。
- Markdown：禁止标识扫描 0 命中；UTF-8 替换字符扫描 0 命中。

## 7. 尚未关闭的发布阻塞

以下项目不属于“已通过本机验证”：

1. Linux CI 尚未在本会话实际运行，因此两项 OS 沙箱集成测试仍待 Ubuntu runner 证明。
2. 没有使用真实业务密钥，Provider 认证矩阵仍待 Batch 5/RC。
3. Windows/Linux 全屏 TUI 人工交互尚未验收。
4. `npm audit` 当前报告 2 个 high、1 个 moderate，均来自锁定底层运行库 `0.83.0` 的依赖链；兼容升级需要单独评估，不能盲目强制修复。
5. 文档站、贡献规范、PR 模板、社区发布工程属于 Batch 5，尚未执行。
6. 没有执行 commit、tag、push、npm/PyPI publish 或 GitHub 发布。

因此当前准确结论是：**Batch 0～4 工程交付完成，Release Candidate 尚未通过，不能宣称生产就绪或 Claude Code parity。**

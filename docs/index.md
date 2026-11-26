---
layout: home

hero:
  name: CoreMind
  text: 把智能体工程经验变成可执行标准
  tagline: 面向新手与普通工程师的配置驱动开发框架，提供 CLI、TypeScript SDK、Python SDK 和完整源码。
  actions:
    - theme: brand
      text: 5 分钟开始
      link: /guide/01-quickstart
    - theme: alt
      text: 阅读配置指南
      link: /guide/02-configuration
    - theme: alt
      text: 查看 GitHub
      link: https://github.com/Eclipseic1848/CoreMind

features:
  - title: 配置驱动
    details: 先选择 TypeScript、JavaScript 或 Python，再用清晰的配置描述模型、工具、权限、预算与质量门禁。
  - title: Harness 内建
    details: 将预算、重试、检查点、追踪、评测与失败恢复放进统一执行边界，减少新手常见错误。
  - title: 三种使用方式
    details: 在终端中交互开发、嵌入现有工程，或直接基于源码扩展；三种入口共享同一运行语义。
  - title: 人始终掌舵
    details: 请求批准、自动批准和完全访问三种权限模式由用户选择，高风险行为拥有明确边界。
  - title: 双语学习材料
    details: 每个功能模块同时提供 README、GUIDE、SOP、Skill、测试入口与变更记录。
  - title: 可验证发布
    details: 供应商认证、跨语言一致性、安装测试和发布预检都依赖可重复的证据，而不是功能声明。
---

## 公开稳定版 `2.1.0`

[从 2.0 升级与回退](migrations/2.0-to-2.1.zh-CN.md) · [从 1.4 升级](migrations/1.4-to-2.0.zh-CN.md) · [2.0 发布说明](release/notes/v2.0.0.md) · [历史 1.0.1→1.2 升级](migrations/1.0-to-1.2.zh-CN.md)

安装 `coremind-cli@2.1.0` 或对应版本的 SDK，在自己的项目中先运行最小 Runtime。[GitHub Release](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.1.0) · [npm CLI](https://www.npmjs.com/package/coremind-cli/v/2.1.0) · [PyPI SDK](https://pypi.org/project/coremind-ai/2.1.0/) · [发布与回装记录](https://github.com/Eclipseic1848/CoreMind/issues/427)

知识、Hindsight 记忆和本体可分别安装 `0.1.0` 服务包。Skill 可按固定提交安装，业务工具可单独注册和更换。[知识](https://pypi.org/project/coremind-knowledge-mcp/0.1.0/) · [Hindsight 记忆](https://pypi.org/project/coremind-memory-mcp/0.1.0/) · [本体](https://pypi.org/project/coremind-ontology-mcp/0.1.0/)

### 在自己的项目里启用第一项能力

从只含模型和一个 Agent 的配置开始，再接入一个组件，分别验证启用和移除。`document-assistant` 提供多项组合的参考。[五域建设方法](guide/06-capability-construction.md)

### 1.4 已合入的能力

- [持久任务](guides/durable-tasks.zh-CN.md)：原子阶段、定义迁移、持久等待与稳定键结果复用；宿主负责 alarm 和显式恢复。
- [会话树与分叉](modules/manage-sessions/GUIDE.zh-CN.md)：命名分支、持久选择与新会话身份，不复制执行授权。
- [跨语言 SDK](modules/embed-coremind-python/GUIDE.zh-CN.md)：TS 与同步/异步 Python 复用唯一 Node Runtime、事实及权限边界，匹配 Protocol v2 能力和指纹。

### 继承自 1.2 的能力

- 标准 `SKILL.md` 索引、按需加载和冻结快照恢复。
- 同 Run 持久 `/steer`、`/follow-up` 与五态控制回执。
- 经权限准入的本地 MCP stdio 工具与取消收尾。
- 固定 HTTP MCP 目标、精确资源授权与受控凭据。
- 宿主显式 OAuth 登录、取消、退出和登出。
- 显式 Config v3 `deferred` 中英文词法发现、声明 generation 与事实重建。
- 逐 Run/Call 终端执行证据、受控 Artifact 引用和安全输入。

Config v2、省略或显式 `direct` 的工具与 Protocol v1 保持兼容；`deferred` 必须显式选用 Config v3。新特性须使用支持相应能力的匹配 SDK 与 bundled Worker；使用 Protocol v2 时还须匹配 Schema 指纹；运行要求 Node.js ≥ 22.19，Python SDK 要求 Python ≥ 3.10。未知副作用仍须人工核对，不能盲目恢复；技能加载与工具发现都不授予新权限。真实外部授权服务器互通及全局成对性能收益尚未认证。

Provider 可配置不等于认证；资格须核对同版本、同提交和 Runtime 摘要的 strict-provider 证据。维护者可查看 [RC 验收指南](/release/RC-ACCEPTANCE.zh-CN)和[发布 SOP](/release/README.zh-CN)。

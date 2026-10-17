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

## 当前发布线：`1.2.0`

[从 1.0.1 直接升级](migrations/1.0-to-1.2.zh-CN.md) · [1.2 发布说明](release/notes/v1.2.0.md)

> `1.2.0` 发布线从 `1.0.1` 直接升级，纳入未独立发布的 1.1 开发成果：标准 Skill、持久控制、受控 MCP/显式 OAuth、工具发现与终端证据；同时包含 Session、最终工具参数、模型请求、自定义认证、输出交付、重复 Call 身份、日志处理、Python 通知消费、项目脚本加载信任和终端编辑。公开可安装状态以 [GitHub Release](https://github.com/Eclipseic1848/CoreMind/releases)、[npm](https://www.npmjs.com/package/coremind-cli) 和 [PyPI](https://pypi.org/project/coremind-ai/) 实时页面及同提交资格证据为准；源码与工程 CI 通过不等于已经发布。

- 标准 `SKILL.md` 索引、按需加载和冻结快照恢复。
- 同 Run 持久 `/steer`、`/follow-up` 与五态控制回执。
- 经权限准入的本地 MCP stdio 工具与取消收尾。
- 固定 HTTP MCP 目标、精确资源授权与受控凭据。
- 宿主显式 OAuth 登录、取消、退出和登出。
- 显式 Config v3 `deferred` 中英文词法发现、声明 generation 与事实重建。
- 逐 Run/Call 终端执行证据、受控 Artifact 引用和安全输入。

Config v2、省略或显式 `direct` 的工具与 Protocol v1 保持兼容；`deferred` 必须显式选用 Config v3。新特性须使用支持相应能力的匹配 SDK 与 bundled Worker；使用 Protocol v2 时还须匹配 Schema 指纹；运行要求 Node.js ≥ 22.19，Python SDK 要求 Python ≥ 3.10。未知副作用仍须人工核对，不能盲目恢复；技能加载与工具发现都不授予新权限。真实外部授权服务器互通及全局成对性能收益尚未认证。

Provider 可配置不等于认证；资格须核对同版本、同提交和 Runtime 摘要的 strict-provider 证据。维护者可查看 [RC 验收指南](/release/RC-ACCEPTANCE.zh-CN)和[发布 SOP](/release/README.zh-CN)。

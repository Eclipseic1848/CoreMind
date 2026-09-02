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

## 当前阶段

CoreMind 当前稳定版为已发布的 `0.3.1`，可从 [GitHub Release](https://github.com/Eclipseic1848/CoreMind/releases/tag/v0.3.1)、npm 与 PyPI 安装；源码始终可用于评审和共同开发。请阅读[公开路线图](/roadmap.zh-CN)、[安全边界](/guide/04-quality)和[供应商认证矩阵](/providers/README.zh-CN)。

`0.3.1` 已在同一发布提交完成 Windows/Linux P01～P20 自动矩阵、双平台真实伪终端、真实 Provider 当次复验和最终文档审计。公开可用版本以 [GitHub Releases](https://github.com/Eclipseic1848/CoreMind/releases)、npm 与 PyPI 为准；维护者可查看 [RC 验收指南](/release/RC-ACCEPTANCE.zh-CN)和[发布 SOP](/release/README.zh-CN)。

当前源码候选统一声明稳定版 `0.7.0`，包含 Protocol v2、统一安全与错误合同，以及贯通四个正式入口的 Child Run 产品链路。双平台工程、候选包和真实 TTY 门禁已通过；严格 Provider 请求在 HTTP 响应前超时，维护者已接受仅限本版本的网络例外，但这不是 live-provider 认证。Tag、Registry、GitHub Release 与公开回装尚未完成，因此公开稳定版仍是 `0.3.1`。

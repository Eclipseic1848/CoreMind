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

CoreMind `0.7.1` 稳定版发布线已完成代码与文档准备，在 Protocol v2、统一安全与错误合同和 Child Run 产品链路之上，补强凭据 Header、Artifact 导入、增量 Fact 持久化、长驻 Worker、TUI 输入与发布失败证据；公开可安装性以 GitHub Release、npm 与 PyPI 实时页面为准。请阅读[公开路线图](/roadmap.zh-CN)、[安全边界](/guide/04-quality)和[供应商认证矩阵](/providers/README.zh-CN)。

仓库内 Provider 台账当前未收录 `0.7.1` 静态认证记录；正式发布必须通过绑定候选提交与 Runtime 摘要的 strict-provider 工作流 Artifact。可配置不等于认证，生产评估必须同时核对供应商矩阵与本版本工作流证据。维护者可查看 [RC 验收指南](/release/RC-ACCEPTANCE.zh-CN)和[发布 SOP](/release/README.zh-CN)。

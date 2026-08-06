# 第三方组件声明（THIRD-PARTY NOTICES）

CoreMind 基于以下开源项目构建，特此声明其版权与许可归属。

## 上游智能体运行时框架（MIT License）

CoreMind 的运行时底座直接依赖以下 npm 包（MIT 协议，Copyright 2025 Mario Zechner）：

- **模型接入包**（统一多模型 API，含 35+ 内置模型提供商）
- **运行时核心包**（headless Agent 运行时，工具调用、事件流、会话持久化）
- **工具工厂来源包**（read/bash/edit/write/grep/find/ls 等内置工具实现）

> 依据 MIT 协议要求，本声明保留其版权声明与许可证文本。上述包自身的 LICENSE 随 npm 安装附带于 `node_modules` 中。

## 其他直接依赖

| 包 | 用途 | 许可 |
|---|---|---|
| typebox | 配置 schema 校验 | MIT |
| yaml | YAML 配置解析 | ISC |

## 内容借鉴

- **模板库组织方式**借鉴自 agency-agents-zh（开源 AI 角色库，其角色人设内容经 CoreMind 重新编排为结构化配置，未直接复制原文）。

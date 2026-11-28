# 第三方组件声明（THIRD-PARTY NOTICES）

CoreMind 基于以下开源项目构建，特此声明其版权与许可归属。

## 上游智能体运行时框架（MIT License）

CoreMind 的运行时底座直接依赖以下三类 npm 包：

- **模型接入包**（统一多模型 API，含 35+ 内置模型提供商）
- **运行时核心包**（headless Agent 运行时，工具调用、事件流、会话持久化）
- **工具工厂来源包**（read/bash/edit/write/grep/find/ls 等内置工具实现）

上游 1.7.0 源码以 MIT 许可发布，版权为 Copyright (c) 2026 Earendil Inc.。三个直接依赖的 npm 发布包均未附独立 LICENSE。CoreMind 在源码中保留上游许可原文，Python wheel 的内置 Worker 也嵌入该原文。[上游运行时许可](packages/coremind-worker/LICENSE.runtime)

历史会话兼容代码保留引入时的 MIT 许可与 Copyright (c) 2025 Mario Zechner 声明。

## 其他直接依赖

| 包 | 用途 | 许可 |
|---|---|---|
| @anthropic-ai/sandbox-runtime | Linux 内置 shell 的 OS 级隔离适配 | Apache-2.0 |
| musl libc | 静态链接到 Linux seccomp 助手，许可随 `musl-COPYRIGHT` 资产提供 | MIT 及文件所列声明 |
| xstate 5.32.5 | 显式 Loop 的内部状态迁移与快照适配；公共合同仍由 CoreMind 定义 | MIT |
| execa 10.0.1 | 跨平台子进程执行、超时、中止与流式输出适配 | MIT |
| diff 9.0.0 | 受限统一差异生成 | BSD-3-Clause |
| fast-check 4.9.0 | 路径、权限、终态、中止与重复动作属性测试（仅开发依赖） | MIT |
| fflate 0.8.3 | 发布门禁中的跨平台源码 ZIP 读取与安全解压（仅开发依赖） | MIT |
| typebox | 配置 schema 校验 | MIT |
| yaml | YAML 配置解析 | ISC |

Linux CI 与目标系统还需要 Bubblewrap 作为系统级沙箱依赖（GNU Library General Public License 2.0）。它不随 npm 包复制发布，由操作系统包管理器安装。

Windows MCP 私有启动器内联锁定的 Execa 及其实际依赖。npm 的 `dist/vendor/windows-mcp/` 与 Python 的 `_worker/vendor/windows-mcp/` 随包保留完整 `THIRD-PARTY-LICENSES.txt`、来源清单及资产摘要；运行时核验固定启动器身份。

## 内容借鉴

- **模板库组织方式**借鉴自 agency-agents-zh（开源 AI 角色库，其角色人设内容经 CoreMind 重新编排为结构化配置，未直接复制原文）。

## 可选组件与服务

- `coremind-knowledge-mcp` 使用 Qdrant Client、ONNX Runtime 和 markdown-it-py。宿主另行提供固定版本的 BGE-M3 模型，按需安装包含 Docling 和 RapidOCR 的 `documents` 扩展。[知识组件依赖清单](components/knowledge/pyproject.toml) · [模型来源与安装](components/knowledge/README.md)
- `coremind-memory-mcp` 使用 Hindsight 客户端连接宿主部署的记忆服务。[记忆组件依赖清单](components/memory/pyproject.toml) · [服务部署](components/memory/README.md)
- `coremind-ontology-mcp` 使用 RDFLib、pySHACL、Python MCP SDK 和 Uvicorn。[本体组件依赖清单](components/ontology/pyproject.toml)
- 浏览器示例通过宿主安装的 Playwright MCP 接入 Chrome。[版本与安装说明](docs/modules/build-tools/BROWSER.en.md)

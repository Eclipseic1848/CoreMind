---

name: shared-release-preflight
description: 当用户要求根据明确给出的环境现状做项目交付前检查时，逐条核对共享依赖清单。普通摘要不用此技能。
metadata: { version: '1.0.0' }
---

# 共享交付前检查

依次读取 `references/dependency-rules.md`、`assets/checklist.json`、`scripts/check-environment.mjs`。只把脚本当参考源码，按用户提供的环境事实逐条核对。

最终只输出一个可直接解析的 JSON 对象，从 `{` 开始，到 `}` 结束。字段依次为 `项目`、`环境`、`交付结论`、`缺项`。按用户原话填写项目名和环境名，省略用于说明类型的“项目”“环境”后缀。

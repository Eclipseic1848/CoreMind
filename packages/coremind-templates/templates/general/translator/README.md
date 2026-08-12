# 中英翻译助手（translator）

中英互译，保持术语一致性，支持任意长文本分段处理。

## 适用场景

- 需要中英互译，且要求术语全文一致、格式不破坏的文档翻译
- 长文本翻译（分段处理，避免截断）

## 快速开始

```bash
coremind create my-translator --template translator --provider alibaba-model-studio
cd my-translator
Copy-Item .env.example .env   # Windows；Linux 使用 cp .env.example .env
coremind run coremind.yaml --prompt "翻译：你好，世界"
```

## 配置要点

- 单 agent 直答模式（无 workflow），配置最简，适合作为入门示例
- 可在 `agents.translator.systemPrompt` 中补充行业术语表（如"API 保持原文"）

## 调优提示

- 需要更严格的术语一致性时，给 agent 配置 `skills: [translation]`（内置翻译技能：术语一致/格式保持/自检清单）
- 翻译专业领域（法律/医疗/技术）时，在 systemPrompt 中追加该领域的术语约定

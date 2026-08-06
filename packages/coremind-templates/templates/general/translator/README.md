# 中英翻译助手（translator）

中英互译，保持术语一致性，支持任意长文本。

## 使用

```bash
# 1. 配置 API key
copy .env.example .env   # 填入 DEEPSEEK_API_KEY

# 2. 运行
coremind run coremind.yaml --prompt "翻译：你好，世界"
```

## 说明

- 单 agent 直答模式（无 workflow），适合快速体验
- 翻译要求：术语前后一致、保留 markdown 格式、只输出译文

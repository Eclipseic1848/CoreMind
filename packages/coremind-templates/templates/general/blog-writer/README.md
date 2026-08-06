# 博客写作助手（blog-writer）

根据要点撰写博客/公众号文章，自动保存为 `article.md`。

## 使用

```bash
copy .env.example .env
coremind run coremind.yaml --prompt "写一篇关于 AI 入门的高中生活应用文章"
```

## 说明

- workflow：先写文章 → 再调用工具写入文件
- 演示了 `write` 工具的落地能力

# 博客写作助手（blog-writer）

根据要点撰写博客/公众号文章，自动保存为 `article.md`。

## 适用场景

- 从要点/大纲生成完整文章（标题、正文、结尾）
- 文章需要落盘为 markdown 文件，便于后续编辑发布

## 快速开始

```bash
coremind create my-blog --template blog-writer
cd my-blog
copy .env.example .env        # 填入 DEEPSEEK_API_KEY
coremind run coremind.yaml --prompt "写一篇关于 AI 入门的高中生活应用文章"
```

## 配置要点

- 两步 workflow：撰写 → 保存为文件（演示 `write` 工具与顺序步骤）
- writer agent 配备 `write` / `bash` 工具

## 调优提示

- 需要固定文章风格（如"口语化""面向学生"）时，在 `agents.writer.systemPrompt` 中描述目标读者与语气
- 想限制篇幅，可在 systemPrompt 中加"正文不超过 1500 字"

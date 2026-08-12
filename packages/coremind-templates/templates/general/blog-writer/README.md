# 博客写作助手（blog-writer）

根据要点撰写博客/公众号文章，自动保存为 `article.md`。

## 适用场景

- 从要点/大纲生成完整文章（标题、正文、结尾）
- 文章需要落盘为 markdown 文件，便于后续编辑发布

## 快速开始

```bash
coremind create my-blog --template blog-writer --provider alibaba-model-studio
cd my-blog
Copy-Item .env.example .env   # Windows；Linux 使用 cp .env.example .env
# 填入创建时所选 Provider 对应的环境变量
coremind run coremind.yaml --prompt "写一篇关于 AI 入门的高中生活应用文章"
```

## 配置要点

- 单步工作流完成撰写与保存，只请求一次 `write` 审批
- writer 只配备 `write` 工具；不得虚构用户未提供的产品功能、价格、网址或试用政策

## 调优提示

- 需要固定文章风格（如"口语化""面向学生"）时，在 `agents.writer.systemPrompt` 中描述目标读者与语气
- 想限制篇幅，可在 systemPrompt 中加"正文不超过 1500 字"

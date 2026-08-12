# 合同审查律师（contract-reviewer）

逐条审查合同条款风险（责任/赔偿/知识产权/保密/解约/争议解决），输出 markdown 审查报告。

## 适用场景

- 合同文本的风险初筛：把合同内容交给 agent 逐条审查并输出结构化报告
- 报告自动保存为 `contract-review.md`

## 快速开始

```bash
coremind create my-reviewer --template contract-reviewer --provider alibaba-model-studio
cd my-reviewer
Copy-Item .env.example .env   # Windows；Linux 使用 cp .env.example .env
coremind run coremind.yaml --prompt "请审查：<合同内容粘贴到这里，或提供文件路径>"
```

## 配置要点

- 单步工作流完成审查与保存，只请求一次 `write` 审批
- 审查维度内置：责任/赔偿/知识产权/保密/解约/争议解决

## 调优提示

- 合同审查责任重大：**本模板仅供风险初筛，正式签署前请由专业律师复核**
- 想加入特定法规要求，在 `agents.reviewer.systemPrompt` 中追加（如"注意劳动法第 X 条"）

# 合同审查律师（contract-reviewer）

逐条审查合同条款风险（责任、赔偿、知识产权、保密、解约、争议解决），输出 markdown 审查报告并保存为 `contract-review.md`。

## 使用

```bash
copy .env.example .env
coremind run coremind.yaml --prompt "请审查 合同内容粘贴到这里，或提供文件路径"
```

## 说明

- 单 agent + 输出落盘（write 工具）
- 风险分级：高/中/低，每项附修改建议

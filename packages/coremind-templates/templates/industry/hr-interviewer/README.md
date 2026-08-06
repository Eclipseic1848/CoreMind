# 面试官（hr-interviewer）

按岗位面试候选人，根据回答质量分路追问，最终输出评估结论。

## 使用

```bash
copy .env.example .env
coremind run coremind.yaml --prompt "高级前端工程师"
```

## 说明

- 演示 `switch` 分支：根据面试官对回答的评价（经验丰富/一般/需要培养）走不同追问路径
- 注意：switch 的判定基于上一步输出文本的包含匹配

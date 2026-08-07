# 面试官（hr-interviewer）

按岗位面试候选人，根据回答质量分路追问，最终输出评估结论。

## 适用场景

- 模拟面试：按岗位展开面试，根据回答质量走不同追问路线
- 演示 `switch` 分支：按回答分类（经验丰富/一般/需要培养）分路提问

## 快速开始

```bash
coremind create my-interviewer --template hr-interviewer
cd my-interviewer
copy .env.example .env        # 填入 DEEPSEEK_API_KEY
coremind run coremind.yaml --prompt "高级前端工程师"
```

## 配置要点

- `switch` 步骤按 `{{prompt}}` 内容分类命中不同追问分支（见 workflow 的 cases）
- 面试官 agent 单角色驱动全部环节（开场 → 分类 → 追问 → 结论）

## 调优提示

- 切换岗位：直接改 `--prompt` 岗位名即可；想固化岗位题库时，在 systemPrompt 中追加该岗位的问题清单
- 追问分支的命中依赖分类关键词：修改 `cases` 键可自定义分类

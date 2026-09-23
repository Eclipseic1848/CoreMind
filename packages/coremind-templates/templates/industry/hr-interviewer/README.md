# 面试官（hr-interviewer）

根据岗位生成面试开场与追问，演示 `switch` 分支。

## 适用场景

- 面试流程演示：根据岗位生成开场和后续问题
- `switch` 当前检查的是首轮 Agent 输出，不会收集候选人回答；不能据此评估候选人

## 快速开始

以下以 PowerShell 为例；Linux 将 `Copy-Item` 换为 `cp`。运行前请在复制出的 `.env` 中填入 `DASHSCOPE_API_KEY`。

```powershell
coremind create my-interviewer --template hr-interviewer --provider alibaba-model-studio --language typescript
cd my-interviewer
Copy-Item .env.example .env
coremind run coremind.yaml --prompt "高级前端工程师"
```

## 配置要点

- `switch` 按 `stage1.text`（Agent 首轮输出）匹配分支；未命中时走默认分支
- 面试官 Agent 负责开场与追问；当前工作流没有候选人输入或真实回答质量分类

## 调优提示

- 切换岗位：直接改 `--prompt` 岗位名即可；想固化岗位题库时，在 systemPrompt 中追加该岗位的问题清单
- 若要评估真实候选人，需先增加收集回答与分类步骤，再让 `switch` 根据该分类分路

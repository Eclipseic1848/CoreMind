# 代码审查员（code-reviewer）

审查指定文件，标记风险等级（高/中/低）并给出修改建议。

## 适用场景

- 提交前审查：对改动文件做一次系统检查
- 检查关注点：bug 风险、安全问题、可读性、性能

## 快速开始

```bash
coremind create my-reviewer --template code-reviewer
cd my-reviewer
copy .env.example .env        # 填入 DEEPSEEK_API_KEY
coremind run coremind.yaml --prompt "审查 src/main.ts"
```

## 配置要点

- reviewer 已配置内置技能 `skills: [code-review]`：按 SOP 逐项检查（正确性/安全/性能/可维护性）并输出 `[高]/[中]/[低]` 分级结论
- `if` 分支：检测到高风险时追加"必须立即修复"建议清单
- 工具：read / grep / find / ls（只读，安全）

## 调优提示

- 审查结果随审查标准不同而变化：在 `agents.reviewer.systemPrompt` 中补充团队规范（如"必须检查单元测试覆盖"）
- 只想快速扫描时，去掉 `check-risk` 的 if 分支可减少一次调用

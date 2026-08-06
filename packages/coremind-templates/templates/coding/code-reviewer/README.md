# 代码审查员（code-reviewer）

审查指定文件，标记风险等级（高/中/低）并给出修改建议。

## 使用

```bash
copy .env.example .env
cd 你的项目目录
coremind run 代码审查配置路径/coremind.yaml --prompt "审查 src/main.ts"
```

## 说明

- 演示 `if` 分支：检测到高风险时输出"必须立即修复"清单
- 使用工具：read / grep / find / ls

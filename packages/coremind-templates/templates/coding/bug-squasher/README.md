# Bug 歼灭师（bug-squasher）

双 agent 协作调试：analyzer 诊断根因 → patcher 实施修复并验证。

## 使用

```bash
copy .env.example .env
cd 出问题的项目目录
coremind run bug-squasher配置路径/coremind.yaml --prompt "运行 npm test 报错：TypeError: xxx is not a function"
```

## 说明

- 演示多 agent 协作（`call` 步骤）：诊断结果通过变量传递给修复者
- analyzer 工具：bash / read / grep / find；patcher 工具：read / edit / write / bash

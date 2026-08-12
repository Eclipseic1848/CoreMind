# Bug 歼灭师（bug-squasher）

双 agent 协作调试：analyzer 诊断根因 → patcher 实施修复并验证。

## 适用场景

- 遇到报错/测试失败，需要"先定位根因、再动手修"的规范调试
- 演示多 agent 协作：诊断结果通过 `{{变量}}` 传递给修复者

## 快速开始

```bash
coremind create my-squasher --template bug-squasher --provider alibaba-model-studio
cd my-squasher
Copy-Item .env.example .env   # Windows；Linux 使用 cp .env.example .env
# 在出问题的项目目录运行：
coremind run coremind.yaml --prompt "运行 npm test 报错：TypeError: xxx is not a function"
```

## 配置要点

- 双 agent：analyzer（诊断，工具 bash/read/grep/find）+ patcher（修复，工具 read/edit/write/bash）
- `call` 步骤：诊断结果作为 patcher 的输入（`{{diag.text}}` 变量传递）

## 调优提示

- 修复质量取决于测试命令的准确性：在 prompt 中给出精确的复现命令
- 需要自动验证修复时，在 workflow 末尾追加一步"运行测试并确认通过"

# Bug 歼灭师（bug-squasher）

双 agent 协作调试：analyzer 诊断根因 → patcher 实施修复并验证。

## 适用场景

- 遇到报错/测试失败，需要"先定位根因、再动手修"的规范调试
- 演示多 agent 协作：诊断结果通过 `{{变量}}` 传递给修复者

## 快速开始

请在待修复的代码仓库根目录使用具备 Shell 隔离能力的 Linux 终端运行；`create .` 会向当前仓库添加 CoreMind 文件。复制后先在 `.env` 中填入 `DASHSCOPE_API_KEY`。模板依赖 `bash`；Windows 默认权限组合不允许执行该步骤。

```bash
coremind create . --template bug-squasher --provider alibaba-model-studio
cp .env.example .env
coremind run coremind.yaml --prompt "运行 npm test 报错：TypeError: xxx is not a function"
```

## 配置要点

- 双 agent：analyzer（诊断，工具 bash/read/grep/find）+ patcher（修复，工具 read/edit/write/bash）
- `call` 步骤：诊断结果作为 patcher 的输入（`{{diag.text}}` 变量传递）

## 调优提示

- 修复质量取决于测试命令的准确性：在 prompt 中给出精确的复现命令
- patcher 的提示词要求运行验证；交付前仍需核对实际工具轨迹和测试结果，不能只凭摘要认定修复通过

# 安全说明

## 报告漏洞

如发现安全漏洞，请通过 GitHub Issues 私有报告（或直接发 Issue 并标注 `security`），**不要**公开披露细节。

## 已知边界

- **工具权限**：内置 `bash` / `edit` / `write` 等工具以运行用户的权限执行，无内置沙箱。运行不可信配置前请评估风险，或使用容器/Docker 隔离。
- **API key**：优先使用环境变量（`DEEPSEEK_API_KEY` 等）；配置文件中直接写 `apiKey` 不推荐（可能随仓库泄露），`.env*` 已在 `.gitignore` 中排除。
- **会话数据**：会话文件为明文 JSONL，勿存放敏感内容。
- **未验证的 YAML**：不要运行来源不明的 `coremind.yaml`——其 workflow 可触发任意命令执行（如 bash 工具）。

# Skill 与 SOP 装载上手指南

## 什么时候使用

把专业 SOP 配给指定 Agent。内置技能和旧 README 保持全文前缀注入；希望按需加载正文时，在配置目录的 `skills/<id>/SKILL.md` 中提供标准文件。

## 最小示例

```yaml
agents:
  reviewer:
    systemPrompt: 你是代码审查助手
    skills:
      - legal-review
```

对应 `skills/legal-review/SKILL.md`：

```markdown
---
name: 合同审查
description: 核对条款与项目约定，标记证据缺口。
---

逐项核对付款、交付和责任；没有业务依据时请求确认。
```

目录 ID 决定授权，名称只作展示。首请求只有索引，Agent 调用 `load_skill({"id":"legal-review"})` 后正文才进入正常工具消息；调用仍服从 ToolPolicy 与预算。旧 `README.md` 可继续使用，同目录双文件选 SKILL 并告警；内置同 ID 仍优先。

单文件上限 256 KiB，解析结果与全部 Agent 冻结快照各最多 2 MiB 序列化 UTF-8 JSON。正文与快照 SHA 均为无前缀的 64 字符十六进制值。标准技能在 Runtime 创建后冻结，Child 和 resume 不切换到当前磁盘版本；新 Runtime 才读取修改。只有实际正文仍在最终工作集中，重复加载才返回引用；压缩移走正文后可重载。

## 编写资源包

在 `SKILL.md` 的 frontmatter 中添加 `metadata.version: "1.0.0"`，其中 `version` 为 `metadata` 下的字段。分发时，目录 ID 和 `name` 使用同一个小写连字符标识。把资源放在 `references/`、`assets/` 或 `scripts/`。例如，用 UTF-8 写入 `assets/template.md`，内容为 `# Template` 后接一个 LF，然后在 `SKILL.md` 同目录创建 `coremind.skill.json`。

```json
{
  "schemaVersion": 1,
  "resources": [
    {
      "path": "assets/template.md",
      "sha256": "338468e66effd66f17adce09f28260126f5f502f3623e7aea481622c0e20f6a3"
    }
  ]
}
```

SHA-256 基于原始字节计算。Windows 可用 `Get-FileHash assets/template.md -Algorithm SHA256` 并把结果转为小写，Linux 可用 `sha256sum assets/template.md`。设置 `.gitattributes` 的 `text eol=lf` 规则，让分发时的字节与计算摘要时一致。Agent 先按需加载正文，再用 `load_skill({"id":"legal-review","resource":"assets/template.md"})` 读取模板。`scripts/` 的声明文件也只返回文本，执行需另走项目的工具授权。

## 固定版本安装和回退

需要 Git、Node.js 22.20.0 或更高版本，以及可读取的公开 GitHub 源。以下命令在 CoreMind 源码仓库根目录运行。先准备两个已存在的配置目录 `project-a` 和 `project-b`，并将 `owner/repo@FULL_COMMIT_SHA` 替换为审查过的仓库和 40 位小写提交 SHA。

```sh
npm run build
npm install --prefix .scratch/skills-cli --cache .scratch/skills-cli/npm-cache --no-save --package-lock=false --ignore-scripts skills@1.9.0
node examples/modules/package-agent-skills/install-skill.mjs project-a legal-review .scratch/skills-cli/node_modules/skills/package.json .scratch/legal-review-v1.lock.json owner/repo@FULL_COMMIT_SHA
node examples/modules/package-agent-skills/install-skill.mjs project-b legal-review .scratch/skills-cli/node_modules/skills/package.json .scratch/legal-review-v1.lock.json
```

安装器先在临时目录使用 Skills CLI 冻结安装，再按 CoreMind 清单和固定提交核对原始字节。校验后先保存可用于冻结重装的内容锁，再替换目标目录。如果替换失败且保留了新锁，可省略源参数，使用同一份锁重试。项目 `skills/<id>/` 只接收 `SKILL.md`、清单和声明的资源。`coremind check project-a/coremind.yaml` 校验 Agent 已选的包。两次安装返回的锁 SHA-256 应一致。

升级时使用新提交和新锁文件名，并保存旧锁。回退时省略源参数，把命令中的 `project-b` 改成 `project-a` 并传回旧锁。新 Runtime 会读取回退后的版本。若安装中断，先确认进程已退出。如果 `skills/<id>/` 缺失且 `skills/.<id>.install/previous` 存在，将 `previous` 移回 `skills/<id>/`。把剩余的 `.<id>.install` 目录移到项目 `skills/` 之外，再重试安装。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 核对首次请求无未加载正文或资源，加载后的 SHA 与请求一致。覆盖重复调用、压缩后重载、源文件变化后的恢复和错误输入。
6. 运行 `node --test examples/modules/package-agent-skills/install-skill.test.mjs`，检查冻结重装、完整性、声明过滤和回退。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
- 不要把索引、引用或用户自述当作正文已驻留；不要用技能请求扩大权限或指定任意路径。
- 原始 Store 含冻结正文；公开投影剥离私有字段不等于业务输出全量脱敏，也不提供防任意篡改的签名。
- 关闭 Session 时，不承诺恢复完整对话；完整请求重建仍要求已有会话和压缩事实。更多边界见[技能指南](../../guide/03-skills.md)。

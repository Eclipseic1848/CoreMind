# Issue tracker：GitHub

本仓库的 Issue 和 PRD 使用 GitHub Issues 管理，所有操作通过 `gh` CLI 完成。

## 仓库

- GitHub：`Eclipseic1848/CoreMind`
- 在本仓库目录内运行时，由 `gh` 根据 Git remote 自动识别仓库。
- 在仓库外运行时，显式传入 `-R Eclipseic1848/CoreMind`。

## 常用操作

- 创建：`gh issue create --title "..." --body-file <文件>`
- 查看：`gh issue view <编号> --comments`
- 列表：`gh issue list --state open --json number,title,body,labels,comments`
- 评论：`gh issue comment <编号> --body-file <文件>`
- 添加标签：`gh issue edit <编号> --add-label "..."`
- 移除标签：`gh issue edit <编号> --remove-label "..."`
- 关闭：先评论说明原因，再运行 `gh issue close <编号>`

包含多行内容时优先使用 UTF-8 Markdown 文件和 `--body-file`，避免依赖不同 Shell 的字符串转义行为。

## PR 作为请求入口

**关闭。** 外部 PR 不自动进入 Issue 分流队列。

```json
{ "prsAsRequestSurface": false }
```

如需改变此规则，直接修改上述标记。

## Skill 约定

- “发布到 Issue tracker”：创建 GitHub Issue。
- “读取相关 Ticket”：运行 `gh issue view <编号> --comments`，同时读取标签。
- 不使用 `.scratch/` 中的本地 Markdown 代替正式 Issue。

# Issue tracker

本仓库使用 **GitHub Issues** 作为 issue 追踪系统。

## 使用方式

- 仓库：`https://github.com/Eclipseic1848/CoreMind`
- 用 `gh` CLI 创建和查询：`gh issue create` / `gh issue list` / `gh issue view <编号>`
- 相关技能（to-tickets / qa 等）读写 issue 时统一走 `gh` CLI，不写本地 markdown 文件

## PRs 作为请求入口

默认**关闭**：外部 PR 不自动进入 issue 追踪队列。如需开启，将下方标记改为 `enabled`：

```json
{ "prsAsRequestSurface": false }
```

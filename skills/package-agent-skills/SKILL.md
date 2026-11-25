---
name: package-agent-skills
description: "Package, share, and roll back reusable CoreMind skills with declared references, assets, and scripts. Use when authoring project skills, pinning Git versions, or diagnosing skill triggers, resource permissions, and frozen recovery."
---

# Skill and SOP Loading

1. Read [the module contract](../../docs/modules/package-agent-skills/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile. For a new procedure, use the [task-to-draft example](../../examples/modules/package-agent-skills/README.en.md). Have the owner edit the draft outside the project's skills directory before copying and explicitly selecting its ID.
3. Follow the [SOP](../../docs/modules/package-agent-skills/SOP.en.md) or [中文 SOP](../../docs/modules/package-agent-skills/SOP.zh-CN.md). Put trigger conditions in `description`, set `metadata.version`, and list reusable files with raw-byte SHA-256 in `coremind.skill.json`.
4. Pin the full Git commit, retain a lock per version, and verify frozen restore in a second project. Use the previous lock to rehearse rollback. Review the package before selecting its ID for an agent.
5. Verify that `load_skill({id, resource})` exposes only the authorized declared resource. Treat a declared script as text. To run a script, use a separately authorized project tool.
6. Test relevant and unrelated tasks, missing prerequisites, current tool permissions, and resume after replacing the package. Inspect RunOutcome and Trace for the actual tool calls and results.
7. Run the tests listed in [module.yaml](../../docs/modules/package-agent-skills/module.yaml) and `npm run check:modules`. Require explicit authorization for publication.

For a Skill-only delivery, start from the owner’s agent and select a single project Skill. Confirm ordinary conversation after deselecting it in a fresh session. A skill package can be updated or rolled back by its own content lock. See the [standalone configuration](../../docs/modules/package-agent-skills/GUIDE.en.md).

中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。

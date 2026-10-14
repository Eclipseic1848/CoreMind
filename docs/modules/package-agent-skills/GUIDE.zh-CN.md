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

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 核对首次请求无未加载正文、加载后正文 SHA 与请求一致；覆盖重复调用、压缩后重载、源文件变化后的恢复和错误输入。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
- 不要把索引、引用或用户自述当作正文已驻留；不要用技能请求扩大权限或指定任意路径。
- 原始 Store 含冻结正文；公开投影剥离私有字段不等于业务输出全量脱敏，也不提供防任意篡改的签名。
- 关闭 Session 时，不承诺恢复完整对话；完整请求重建仍要求已有会话和压缩事实。更多边界见[技能指南](../../guide/03-skills.md)。

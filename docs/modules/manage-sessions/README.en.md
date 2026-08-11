# Sessions and Context

Status: \`0.3.0-rc.1\` release candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Persist multi-turn messages, fail clearly on corrupt recovery, and protect context deterministically before provider calls.

## Public interfaces

- `CoreMindSession`
- `ChatSession`
- `ContextProtector`

## Errors and boundaries

- session_restore_failed: stop on corruption instead of silently starting over
- Context compaction preserves recent complete turns and emits an event; failure emits `context_compaction_failed` instead of silently truncating
- Summaries preserve goals, constraints, permissions, modified files, test status, and next steps

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/session.ts](../../../packages/coremind-runtime/src/session.ts)
- [packages/coremind-runtime/src/chat-session.ts](../../../packages/coremind-runtime/src/chat-session.ts)
- [packages/coremind-runtime/src/context.ts](../../../packages/coremind-runtime/src/context.ts)
- [packages/coremind-runtime/src/session.test.ts](../../../packages/coremind-runtime/src/session.test.ts)
- [packages/coremind-runtime/src/chat-session.test.ts](../../../packages/coremind-runtime/src/chat-session.test.ts)
- [packages/coremind-runtime/src/context.test.ts](../../../packages/coremind-runtime/src/context.test.ts)
- [模块示例](../../../examples/modules/manage-sessions/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-sessions/README.en.md)
- [Agent Skill](../../../skills/manage-sessions/SKILL.md)

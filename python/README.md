# CoreMind Python SDK

Python SDK 通过本地 stdio JSON-RPC 调用与 TypeScript/CLI 相同的 Node Runtime，不维护第二套 Agent Loop。

当前为 Beta 候选包；完整中英文指南见仓库 `docs/modules/embed-coremind-python/`。

同步和异步客户端都提供 `resume_run(run_id, input=None)`。它只恢复 Node Runtime 判定为安全的未完成运行，不会绕过配置指纹、输入一致性或副作用重放检查。

The Python SDK talks to the same Node runtime over local stdio JSON-RPC; it does not maintain a second Agent Loop. See `docs/modules/embed-coremind-python/` for the bilingual guide.

Both clients expose `resume_run(run_id, input=None)`. It resumes only unfinished runs that pass the shared runtime safety checks.

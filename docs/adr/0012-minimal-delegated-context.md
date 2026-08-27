# Child Run 默认使用最小 Delegated Context

Child Run 只接收任务、稳定项目规则、继承的安全约束，以及 Runtime 在 Config 范围和敏感边界内解析出的显式 Fact/Artifact 引用；它不复制父 Session 全文，也不自动暴露未引用文件、凭据、完整工具输出或未知 Effect 正文。父级只接收子级的结构化结果与证据引用，因为共享完整消息树会扩大数据边界并破坏父子事实域的独立性。

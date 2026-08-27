# 所有执行入口共享一个不可绕过的安全门

CLI 的 run、chat、eval，TypeScript/Python SDK、Worker 与 Child Run 在产生 Provider、工具或子级副作用前，必须通过同一个 Execution Security Gate；check 命令复用相同规则。配置中的 apiKey 以及按名称识别的 Authorization、Proxy-Authorization、X-API-Key、Cookie 等敏感 Header 不得保存明文，只能引用环境变量或 SecretRef，并在 Provider Adapter 边界解析；引用缺失时必须在出站前失败且不可强制跳过。普通非敏感 Header 可以保留字面量，因为只保护 apiKey 或只在 check 中检查会让真实执行入口绕过同一安全边界。

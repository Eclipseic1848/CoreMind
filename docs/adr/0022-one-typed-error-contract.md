# 所有入口共享一个类型化 Error Contract

CoreMind 自有错误必须先登记到唯一 Error Contract，再由该注册表派生终态、重试、取消、Protocol、CLI 与文档语义；未登记字面量在类型检查或 CI 中失败。Provider、工具和 Adapter 的未知异常规范化为已登记的 `unclassified_error` 并暂停等待人工处理，历史 Fact 的未知原始码保留用于审计但不自动重试，因为入口各自猜测或把未知错误视为瞬态可能重复费用和副作用。

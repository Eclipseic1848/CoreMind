# Delegation Budget 成功预留后不退款

Config 为父级定义委派总池，并为每个 Delegation Target 定义默认额度和上限；Child Run 创建时一次性预留 token、工具调用、费用、wall time、步骤和后代数，只有创建前初始化失败才释放。成功创建后不按未使用量退款，因为崩溃、Resume 和未知 Effect 下无法始终证明真实消耗，退款会让同一父级获得不可审计的重复消费空间；深度、活动子级数和后代总数继续使用可收紧但不可扩大的安全上限。

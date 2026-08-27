# Child Run 继承项目级 Provider

`0.7.0` 保留 Config v2 的单项目 Provider 边界：命名 Delegation Target 可以配置自己的模型与模型参数，但 Delegation Tool 不能覆盖 Provider 或模型，Child Run 创建时把解析后的路由固化为事实。本期不引入多 Provider 配置或跨 Provider 委派，因为它们会新增凭据、出站目标、费用归属和认证矩阵，而不是 Child Run 产品化的必要条件。

# 客服工单分诊（customer-triage）

工单自动分类（售后/咨询/投诉/技术故障）并起草对应回复。

## 使用

```bash
copy .env.example .env
coremind run coremind.yaml --prompt "我的订单 3 天没发货，客服电话打不通，我要投诉！"
```

## 说明

- 双 agent：classifier（只输出分类）→ responder（按分类起草回复）
- 演示 `switch` 四路分支 + `default` 兜底（无法分类时转人工）

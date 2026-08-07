# 客服工单分诊（customer-triage）

工单自动分类（售后/咨询/投诉/技术故障）并起草对应回复。

## 适用场景

- 客服工单自动分诊：分类 + 按类型起草回复初稿
- 演示双 agent + `switch` 分类：classifier 分类 → responder 按类型分路回复

## 快速开始

```bash
coremind create my-triage --template customer-triage
cd my-triage
copy .env.example .env        # 填入 DEEPSEEK_API_KEY
coremind run coremind.yaml --prompt "我的订单 3 天没发货，客服电话打不通，我要投诉！"
```

## 配置要点

- 双 agent：classifier（分类）+ responder（起草回复）
- `call` 传递分类结果 → `switch` 按分类命中回复分支（投诉/技术/售后/咨询）

## 调优提示

- 新增工单类型：在 `switch.cases` 中加一类，并在 `agents.responder.systemPrompt` 中补充对应回复要点
- 分类准确率依赖关键词：可调整 classifier 的 systemPrompt 明确各分类判定标准

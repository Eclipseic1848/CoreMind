# 质量与调优

跑完智能体，怎么判断好不好、怎么改进？本指南讲 CoreMind 的质量保障机制。

## 1. 质量摘要：跑完知道好不好

每次 `coremind run` 结束，默认模式打印一行质量摘要：

```
✓ 运行完成：4 步骤全部成功 · 工具 3 次调用 · 耗时 12.3s · 约 5,240 tokens · 输出 320 字
```

有失败时会明确标出：

```
✓ 运行完成：3/4 步骤成功（1 失败） · 工具 5 次调用（2 失败） · 耗时 20.1s · ...
```

**怎么看**：步骤失败 → 哪步失败（看前面的 `✗` 事件）；工具失败 → 工具调用是否正确；token 异常高 → 上下文过长或循环过多。

## 2. 质量把关：输出不达标自动重试

workflow 步骤可以配置重试条件——输出含"错误""失败"等关键词时自动重跑：

```yaml
workflow:
  - id: fix
    type: prompt
    agent: patcher
    input: 修复这个 bug：{{bug.text}}
    saveAs: fix
    retry:
      max: 2                        # 最多重试 2 次（共 3 次尝试）
      if: "{{text}} contains 失败"   # 输出包含"失败"就重试
```

重试次数耗尽后**不会中断**工作流——接受最后输出并告警提示。

## 3. 护栏：智能体不会失控

| 护栏 | 默认 | 作用 |
|---|---|---|
| 嵌套深度 | ≤ 8 层 | 防止 workflow 无限嵌套 |
| 总步骤 | ≤ 100 | 防止死循环（`--max-steps <n>` 收紧） |
| 单步超时 | 5 分钟 | 防止单步卡死（超时自动中止） |
| 工具数量 | ≤ 20/agent | 防止工具过多降低选择准确率（超限告警） |

## 4. 会话与上下文

长对话的上下文管理：

- **断点续聊**：`--session <id>` 保存，再次运行自动恢复历史（chat 退出时也会自动保存；会话文件存于 `session.dir`，默认相对配置文件目录）
- **自动压缩**：`session.compact: true` 时，上下文超预算自动用 LLM 摘要压缩旧历史（**非破坏式**：压缩只影响请求视图，会话文件完整保留）
- 自定义 provider 记得配置真实 `contextWindow`/`maxTokens`（缺省按 32768/4096 保守计算），预算判断才准确

## 5. 常见质量问题排查

| 现象 | 排查方向 |
|---|---|
| 输出答非所问 | systemPrompt 不够具体；试试配相关技能 |
| 输出格式不稳定 | 给 agent 配技能（如 code-review 的分级输出）；或降低 `temperature` |
| 工具调用失败多 | 检查工具参数是否正确；工具是否在白名单/已配 key（web-search 需 TAVILY_API_KEY） |
| token 消耗高 | 检查 workflow 步骤数；长会话开 `session.compact` |
| 步骤超时 | 任务太重：拆小步骤、给更多工具；或调大 `stepTimeoutMs`（库方式） |
| 结果不符合预期 | 用 `retry.if` 加质量检查；或调整 prompt 让要求更明确 |

## 6. 库方式获取质量数据

```ts
import { CoreMindRuntime, formatQuality } from "coremind-ai";

const result = await runtime.run();
console.log(formatQuality(result.quality));   // 质量摘要文本
// result.quality = { steps: {total, ok, failed}, tools: {total, failed}, elapsedMs, tokens?, outputChars }
```

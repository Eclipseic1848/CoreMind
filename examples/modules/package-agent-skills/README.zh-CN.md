# 复用部门周报和交付前检查

[示例配置](coremind.yaml)为同一个 Agent 选择两份版本为 `1.0.0` 的 Skill 包，只授权 `load_skill`。

- 交付一部和平台研发部复用同一周报模板与填写规则。成稿保留各部门提供的进展、阻碍和安排。
- 星塔项目的预发布环境和云桥项目的离线联调环境复用同一核对清单。预发布环境通过，离线联调环境报告 Node.js 版本偏低和回滚快照缺失。
- 一条普通通知摘要全程不调用技能工具，用于检查技能的适用范围。

## 运行四入口示例

从仓库根目录运行。需要 Node.js、仓库依赖和 Python 3.10 或更高版本。若 `python` 指向其他解释器，可将 `COREMIND_SKILL_PYTHON` 设为解释器的绝对路径。

```sh
npm run build
node examples/modules/package-agent-skills/acceptance.mjs
```

脚本启动本机回环模型夹具，将两个技能包复制到独立临时项目，逐一用 CLI + YAML、TypeScript SDK、Python 同步和异步 SDK 运行[五个用例](cases.json)。预期输出 20 条 JSON 记录，含入口、用例、技能调用和业务结果。脚本还逐字核对实际返回的资源，确认脚本源码读取后没有生成执行哨兵。该命令验证接口、数据隔离和流程契约。真实模型能否按需选用资源，需要同题成对评测。

## 真实模型成对评测

使用已授权且无需密钥的 Qwen 兼容端点。将 `COREMIND_SKILL_EVAL_BASE_URL` 设为兼容接口地址，将 `COREMIND_SKILL_EVAL_MODEL` 设为服务实际提供的模型名。

```sh
node examples/modules/package-agent-skills/paired-evaluation.mjs --plan
node examples/modules/package-agent-skills/paired-evaluation.mjs --run
```

脚本串行用相同题目和模型配置对比启用及禁用技能，记录各题评分、原始输出、工具调用、耗时和服务返回的 Token 用量。报告保存在 `.scratch/p2/skill-sharing/live-eval/`。在 `--run` 后追加题目 ID 可只运行指定题目。`--rescore <报告路径>` 对已有结果离线计分。

定制时，将 `skills/` 下的技能包放进项目配置目录。先修改说明、模板和清单资源，再按文件原始 UTF-8 字节更新 `coremind.skill.json` 中的 SHA-256。调整 YAML 的 Provider 和 `skills`，运行 `coremind check <配置文件>`。固定版本分发和回退见[开发 SOP](../../../docs/modules/package-agent-skills/SOP.zh-CN.md)，配置说明见[中文指南](../../../docs/modules/package-agent-skills/GUIDE.zh-CN.md)。

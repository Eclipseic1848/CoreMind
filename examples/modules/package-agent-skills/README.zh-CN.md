# 复用部门周报和交付前检查

[示例配置](coremind.yaml)为同一个 Agent 选择两份版本为 `1.0.0` 的 Skill 包，只授权 `load_skill`。

- 交付一部和平台研发部复用同一周报模板与填写规则。成稿保留各部门提供的进展、阻碍和安排。
- 星塔项目的预发布环境和云桥项目的离线联调环境复用同一核对清单。预发布环境通过，离线联调环境报告 Node.js 版本偏低和回滚快照缺失。
- 一条普通通知摘要全程不调用技能工具，用于检查技能的适用范围。

只需要一份本地 Skill 时，可从本目录选一个 `skills/<id>/` 复制到自己项目配置目录的 `skills/<id>/`，在目标 Agent 的 `skills` 中只列该 ID。也可直接编写 `SKILL.md`。[独立启停指南](../../../docs/modules/package-agent-skills/GUIDE.zh-CN.md)包含完整配置。下方源码示例提供草稿生成、验收脚本和模型夹具。2.1.0 候选的 `coremind-templates` 包提供固定版本安装器 `coremind-skill-install`。已安装的 CLI 可以直接读取本地 Skill。

## 从任务说明生成可编辑草稿

先在仓库根目录执行 `npm ci`、`npm run build`。下面的本地命令将任务说明填入标准 Skill 模板，调用项目使用的加载器校验格式，无需模型凭据。

```sh
node examples/modules/package-agent-skills/draft-skill.mjs .scratch/skill-drafts compare-records "比对两份资料，逐条标出变化，附资料版本和原文位置。"
node --test examples/modules/package-agent-skills/draft-skill.test.mjs
```

打开生成的 `.scratch/skill-drafts/compare-records/SKILL.md`。草稿用同一份任务说明给出“执行并交付”和“仅转述”的触发正反例。将其改成真实业务场景，在 `description` 写清适用范围，并编辑正文的操作步骤和验收样例。同一目录内重复生成该 ID 会拒绝覆盖。负责人审核后，将整个 `compare-records` 目录复制到项目配置旁的 `skills/`，在目标 Agent 的 `skills` 中加入 `compare-records`，再运行 `coremind check <配置文件>`。只有显式选择该 ID 的新 Runtime 才加载它。

## 运行四入口示例

从仓库根目录运行。需要 Node.js、仓库依赖和 Python 3.10 或更高版本。若 `python` 指向其他解释器，可将 `COREMIND_SKILL_PYTHON` 设为解释器的绝对路径。

```sh
npm run build
node examples/modules/package-agent-skills/acceptance.mjs
```

脚本启动本机回环模型夹具，将两个技能包复制到独立临时项目，逐一用 CLI + YAML、TypeScript SDK、Python 同步和异步 SDK 运行[五个用例](cases.json)。预期输出 20 条 JSON 记录，含入口、用例、技能调用和业务结果。脚本还逐字核对实际返回的资源，确认脚本源码读取后没有生成执行哨兵。该命令验证接口、数据隔离和流程契约。真实模型能否按需选用资源，需要同题成对评测。

要复验固定安装版，先把两份 Skill 装到同一配置目录，再将该目录作为 `acceptance.mjs` 的第一个参数。[安装步骤](../../../docs/modules/package-agent-skills/GUIDE.zh-CN.md#固定版本安装和回退)

## 真实模型成对评测

使用已授权且无需密钥的 Qwen 兼容端点。将 `COREMIND_SKILL_EVAL_BASE_URL` 设为兼容接口地址，将 `COREMIND_SKILL_EVAL_MODEL` 设为服务实际提供的模型名。

```sh
node examples/modules/package-agent-skills/paired-evaluation.mjs --plan
node examples/modules/package-agent-skills/paired-evaluation.mjs --run
```

脚本串行用相同题目和模型配置对比启用及禁用技能，记录各题评分、原始输出、工具调用、耗时和服务返回的 Token 用量。报告保存在 `.scratch/p2/skill-sharing/live-eval/`。在 `--run` 后追加题目 ID 可只运行指定题目。`--rescore <报告路径>` 对已有结果离线计分。

定制时，将 `skills/` 下的技能包放进项目配置目录。先修改说明、模板和清单资源，再按文件原始 UTF-8 字节更新 `coremind.skill.json` 中的 SHA-256。调整 YAML 的 Provider 和 `skills`，运行 `coremind check <配置文件>`。固定版本分发和回退见[开发 SOP](../../../docs/modules/package-agent-skills/SOP.zh-CN.md)，配置说明见[中文指南](../../../docs/modules/package-agent-skills/GUIDE.zh-CN.md)。

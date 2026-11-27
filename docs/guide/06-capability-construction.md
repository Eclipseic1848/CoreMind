# 按能力图谱建设通用智能体

[English](../en/guide/06-capability-construction.md)

《智能体构建能力图谱 V1.0.2》的 04–08 共 20 个子项。业务方提供资料、身份、业务规则和验收样本，CoreMind 提供可组合的模块。TypeScript SDK、CLI + YAML、Python 同步及异步 SDK 共用同一 Node Runtime。每个模块的 SOP 给出实施步骤，开发 Skill 供工程团队复用，示例包含配置、运行命令与预期结果。

## 从自己的项目开始

在业务项目根目录创建 `coremind.yaml`，只配置模型和一个 Agent。CoreMind 2.2.0 的最小配置可以独立运行 Runtime。

```yaml
schemaVersion: 2
name: my-project
provider:
  id: deepseek
  model: deepseek-flash
  apiKeyEnv: DEEPSEEK_API_KEY
agents:
  main:
    systemPrompt: 根据用户提供的文字回答问题。
```

把模型凭据放入运行环境。在该目录执行 `npx coremind-cli@2.2.0 run coremind.yaml --prompt "请只回答 OK"`，核对回复和零工具调用。记录这份配置和依赖版本，作为逐项启用能力时的对照。

也可执行 `npx coremind-cli@2.2.0 create . --runtime-only --provider deepseek --model deepseek-flash` 生成配置。已有 `coremind.yaml` 时沿用该文件。[升级与回退](../migrations/2.1-to-2.2.zh-CN.md) · [SDK 最小入口](../../examples/modules/configure-coremind/README.zh-CN.md)

知识、记忆和本体各自使用独立 Python 环境。按业务需求选择下表对应服务即可。

| 仅选用一项时 | 2.2.0 的接入方式 | 第一个验收动作 |
| --- | --- | --- |
| 知识 | `python -m pip install coremind-knowledge-mcp==0.1.1`。部署知识 MCP 服务，在 Agent 工具列表中绑定所需的检索操作 | 提供两版原文，用读者身份检索并回查版本和出处 |
| Hindsight 记忆 | `python -m pip install coremind-memory-mcp==0.1.1`。启动网关并绑定 Hindsight 记忆库，单独授权 Agent 的召回接口 | 宿主写入已确认偏好，新会话召回，另一主体无法读取 |
| Skill | 从 `skills/<id>/SKILL.md` 定义方法，在 `agents.main.skills` 选择 ID。跨项目安装使用 `coremind-templates@2.2.0` 中的 `coremind-skill-install` | 适用任务能加载正文，移除 ID 后新运行无法加载 |
| 工具 | 通过 2.2.0 SDK 注册业务函数，或用配置绑定 stdio/HTTP MCP 操作，并为 Agent 选择工具 | 验证输入、权限和一次业务回执，移除绑定后在新运行中检查工具清单 |
| 本体 | `python -m pip install coremind-ontology-mcp==0.1.1`。提供模型、映射和约束，经本体 MCP 服务绑定所需操作 | 用自己的模型验证一条合规记录和一条违规记录，只读项目仅授权查询、校验 |

知识、记忆和本体使用 Runtime 的 MCP 接口。2.0.0 将这些服务及适配实现随源码示例交付，2.1.0 提供各自的 PyPI 安装包。每项组件交付实现、版本与兼容范围、实施 SOP、开发 Skill 和只启用自身的最小可运行示例。[知识服务](../../components/knowledge/README.md) · [记忆网关](../../components/memory/README.md) · [本体服务](../../components/ontology/README.md) · [路线图](../roadmap.zh-CN.md)

**空白项目验收顺序**

1. 在仓库外建立只运行 Runtime 的项目。保留成功输出，确认未启动五域服务、未加载业务 Skill 或业务工具。
2. 每次从同一基线任选一项，记录启用、实际调用和移除后的结果。只提供该项所需的依赖、配置、数据与凭据。独立升级或回退该项，同时核对宿主状态和其他组件版本。
3. 选一个实际需要的组合，例如知识与 Skill。再移除其中一项，验证剩余能力仍可用。CLI、TypeScript、Python 同步和异步入口用同一份项目配置核对结果。

`document-assistant` 是资料整理的参考示例和组合回归。以下为 2.0.0 的验收记录。它在两个独立项目里用合成资料、真实 Qwen、Qdrant/BGE-M3、Hindsight/PostgreSQL 和可选本体验证了七例。可查阅输入、权限、预期输出和失败记录来设计自己的测试。[组合示例](../../examples/modules/manage-ontology/README.zh-CN.md) · [真实服务组合验收](../../examples/modules/manage-ontology/LIVE-COMPOSITION.zh-CN.md)

业务代码可以先经标准 MCP 查询选定组件，再把同一服务地址和读令牌交给 Agent。两个空白项目示例分别覆盖 TypeScript 的知识检索与引文回查、Python 的 Hindsight 召回。[TypeScript 知识示例](../../examples/modules/manage-knowledge/README.zh-CN.md#从空白-typescript-项目直接查询) · [Python 记忆示例](../../examples/modules/manage-memory/README.zh-CN.md#从空白-python-项目直接召回)

### 复跑独立安装验收

[按需部署与恢复示例](../../examples/optional-components/README.zh-CN.md)给出知识、Hindsight 和本体的版本、启动顺序、持久数据、恢复演练和三项组合的验收命令。

2.1.0 的仓库外验收用冻结提交构建的安装包完成 49 项检查，覆盖空白项目、五项单用、组合和移除。安装公开版后，可用相同脚本复验。[冻结件验收记录](https://github.com/Eclipseic1848/CoreMind/issues/426) · [正式发布与回装](https://github.com/Eclipseic1848/CoreMind/issues/427)

在仓库外新建消费者，固定安装 `coremind-cli@2.2.0`、TypeScript 的 `coremind-ai@2.2.0` 和带内置 Worker 的 Python `coremind-ai==2.2.0`。按上表分别安装和启动知识、记忆与本体服务。在私有 JSON 中以 `knowledge`、`memory`、`ontology` 为键，分别填写回环 `url`、读令牌 `authorization`、只读 `tool` 名、`args` 和预期结果片段 `expect`。记忆场景先由宿主写入合成事实，再执行主仓库的[验收脚本](../../scripts/verify-optional-consumer.mjs)。

```sh
node scripts/verify-optional-consumer.mjs <消费者目录> <已安装SDK的Python> <私有JSON>
```

脚本生成 `optional-acceptance.json`，记录四个入口看到的工具和成功调用数。模型为本地确定性夹具，三个 MCP 服务使用实际安装件。去掉私有 JSON 参数可复跑 Runtime、Skill 和工具用例。

## 04 知识管理

[开发 SOP](../modules/manage-knowledge/SOP.zh-CN.md) · [开发 Skill](../../skills/manage-knowledge/SKILL.md) · [可运行示例及检索结果](../../examples/modules/manage-knowledge/README.zh-CN.md)

| 图谱子项 | 入口与已验证行为 | 业务方交付及边界 |
| --- | --- | --- |
| 04.01 资料接入与解析 | `docling_bridge.py` 用 Docling 与 RapidOCR 解析中文原生及扫描 PDF、表格 DOCX 和 Markdown，保留页码、章节或来源位置。 | 提供原件与预期单元格、段落或页码。按各格式实测定位精度。 |
| 04.02 知识组织与索引 | `knowledge_server.py --state` 保存文档身份和版本。重复导入保持幂等，同版本内容冲突被拒，重建失败保留旧索引。 | 提供清单、稳定 ID、版本、有效期和阅读范围。当前源码可按需[启用持久 Qdrant](../modules/manage-knowledge/GUIDE.zh-CN.md#选用持久-qdrant-索引)。 |
| 04.03 检索排序与取证 | `search_knowledge` 在宿主指定范围内检索。30 道中文合成题中，关键词、稠密、稀疏、混合四种方法的前五条均命中 30/30，稀疏首条命中 30/30。 | 准备同义改写、精确编号、越权及无答案题。检索返回相似片段时仍需单独验证回答和引文。四入口对照用模型夹具驱动真实检索。 |
| 04.04 更新溯源与引用 | 宿主用 `--withdraw` 撤回版本，新检索排除该版本。当前源码支持 PDF、DOCX 片段的 `chunkId` 精确回查，并对匹配多片段的旧页码或章节返回 `ambiguous`。[接入指南](../modules/manage-knowledge/GUIDE.zh-CN.md) | 提供版本替换、撤回权限和保留规则。重建后核对新旧引文，并用同页或同节多片段检查搜索与回查的正文一致。 |

## 05 记忆管理

[开发 SOP 与实测记录](../modules/manage-memory/SOP.zh-CN.md) · [开发 Skill](../../skills/manage-memory/SKILL.md) · [可运行示例](../../examples/modules/manage-memory/README.zh-CN.md)

| 图谱子项 | 入口与已验证行为 | 业务方交付及边界 |
| --- | --- | --- |
| 05.01 会话与长期记忆 | CoreMind 保存会话状态，Hindsight 1.2.3 与 PostgreSQL 保存长期记忆。用读者绑定验证了新会话召回与项目、主体、Agent、分支隔离。 | 指定哪些会话共享记忆库，提供各范围的凭据和跨范围反例。 |
| 05.02 记忆写入与召回 | 宿主用管理接口 `retain` 保存已确认事实，Agent 通过 `recall_memory` 查询。用同一文档 ID 与预期版本测试重复提交，四入口召回同一有效版本。 | 提供来源、文档 ID、确认人和有效期。管理凭据留在宿主侧。 |
| 05.03 经验提炼与反思 | `reflect` 产出待确认候选。真实 `deepseek-flash` 在五道合成题中有直接证据时产出 3/3，缺少关键证据时拒绝 2/2。确认与撤回决定后续可见性。 | 提供允许使用的证据、适用条件、反例和确认流程。在业务样本上另测错误提炼与错误采用。 |
| 05.04 更新遗忘与纠错 | 宿主更正、到期或遗忘后，仅有效版本可见。PostgreSQL 逻辑还原后，遗忘回执挡住旧记录，重放删除清理 Hindsight 派生记录。 | 定义期限、删除责任和恢复时的重放顺序。物理备份、时间点恢复和备份介质清理按实际部署验收。 |

## 06 本体建模（可选）

[开发 SOP 与实测记录](../modules/manage-ontology/SOP.zh-CN.md) · [开发 Skill](../../skills/manage-ontology/SKILL.md) · [可运行示例与两套模型](../../examples/modules/manage-ontology/README.zh-CN.md)

| 图谱子项 | 入口与已验证行为 | 业务方交付及边界 |
| --- | --- | --- |
| 06.01 对象与关系建模 | `ontology_describe` 用 RDFLib 查询类型、属性和关系。资料、设备两套模型使用同一适配器。四入口验证了启用、停用和模型损坏。 | 提供经审核的 `model.ttl` 和 `data.ttl`，以第二套领域词汇验证可替换性。 |
| 06.02 业务概念对齐 | `ontology_validate_record` 按 `mapping.json` 归一标识、字段、编码及单位。冲突或歧义返回 `needs_confirmation`，保留原始值与映射版本。 | 提供映射表及一组同名异义记录，指定谁能确认歧义。 |
| 06.03 规则约束与校验 | pySHACL 对 `shapes.ttl` 运行真实校验。检查合规、违规与引擎不可用，违规报告给出对象、路径、规则和解释。 | 提供业务形状、合规与违规实例。保存模型与形状版本以便复现。 |
| 06.04 业务动作语义 | `ontology_inspect_action`、`ontology_perform_action` 检查前态、权限和预期后态。测试覆盖拒绝时零执行、已确认回执复读，以及丢失回执后同一目标禁止重复写入。 | 提供 `actions.json`、真实处理器、持久请求 ID 及业务系统回执。演示处理器只在进程内运行。 |

## 07 工具集成

[开发 SOP 与实测记录](../modules/build-tools/SOP.zh-CN.md) · [开发 Skill](../../skills/build-tools/SKILL.md) · [可运行示例](../../examples/modules/build-tools/README.zh-CN.md)

| 图谱子项 | 入口与已验证行为 | 业务方交付及边界 |
| --- | --- | --- |
| 07.01 工具注册与发现 | 用 `defineTool` 注册业务函数，或在配置中为 Agent 选取工具。延迟装载时使用 `discover_tools`。可见目录、批准、实际调用分别检查。[配置指南](02-configuration.md) | 提供工具 ID、描述、输入和授权范围。另用无权 Agent 验证目录和调用权限。 |
| 07.02 接口与协议适配 | `transport-parity.mjs` 用确定性模型夹具分别调用本地函数、真实 stdio MCP 和回环 HTTP MCP；Windows 与 Linux 对同一输入均保留 `false`、`0`、`null`。 | 替换本地处理器、启动命令或固定服务地址及凭据。在实际服务上验证超时、取消和断连。 |
| 07.03 工具调用与校验 | 工具输入支持 draft-07、显式 Draft 2020-12 和未知方言拒绝。写后断连保留 `unknown`，测试检查冷恢复不会重复执行。 | 提供参数 Schema、业务结果判据和幂等键。未知效果需从业务系统查询回执。 |
| 07.04 浏览器与代码执行 | 可选 Playwright MCP 在 Windows Chrome 157 上实测筛选、截图、CSV 与取消后释放进程。Linux 容器验证命令输出、超时与进程树清理。[浏览器验收](../modules/build-tools/BROWSER.zh-CN.md) | 指定允许访问的页面、文件目录及命令。按目标操作系统、浏览器版本复测。 |

## 08 技能构建

[开发 SOP 与实测记录](../modules/package-agent-skills/SOP.zh-CN.md) · [开发 Skill](../../skills/package-agent-skills/SKILL.md) · [可运行示例及评测输入](../../examples/modules/package-agent-skills/README.zh-CN.md)

| 图谱子项 | 入口与已验证行为 | 业务方交付及边界 |
| --- | --- | --- |
| 08.01 技能编写与生成 | `draft-skill.mjs` 从任务说明生成可编辑的标准 `SKILL.md`。同 ID 拒绝覆盖，回归用真实加载器验证人工修改和显式选择。 | 提供任务说明、触发和拒绝条件、输出样例。负责人审核草稿后复制进项目并为 Agent 选择 ID。[编写指南](../modules/package-agent-skills/GUIDE.zh-CN.md) |
| 08.02 技能检索与加载 | 运行时先提供索引，`load_skill({id})` 按需载入已授权正文。两套 Skill 用五道确定性用例对照四入口，普通摘要零触发，冷恢复使用冻结版本。 | 明确相近技能各自的适用条件，准备应触发及不应触发任务。 |
| 08.03 方法与资源复用 | `load_skill({id, resource})` 读取声明路径和摘要匹配的资源。周报模板跨两项任务复用；脚本源码可读，加载过程的执行哨兵未生成。 | 提供模板、参考和资源摘要。执行脚本时另行注册工具与权限。 |
| 08.04 技能验证与共享 | 两个干净项目以固定 Git 提交安装和冻结重装。真实 Qwen 同题开关对照首轮严格评分 3/5、1/5；细化输出要求后仅复测原两道，分别 2/2、0/2。 | 锁定来源、版本和内容，验证升级与回退。用目标业务题按相同规则评估触发和任务结果。 |

## 12 效果评测与回归

逐项启用能力时从[五项能力离线回归](../../examples/modules/evaluate-agents/README.zh-CN.md#五项可选能力离线回归)复跑并保存 JSON。用业务方的未见题和预先确认的证据替换合成资料，比较知识召回和引文、记忆经验采用、Skill 误触发和成本，以及工具与本体的实际回执。[评测 SOP](../modules/evaluate-agents/SOP.zh-CN.md#五项可选能力效果回归)

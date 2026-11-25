# 按能力图谱建设通用智能体

[English](../en/guide/06-capability-construction.md)

《智能体构建能力图谱 V1.0.2》的 04–08 共 20 个子项。业务方提供资料、身份、业务规则和验收样本，CoreMind 提供可组合的模块。TypeScript SDK、CLI + YAML、Python 同步及异步 SDK 共用同一 Node Runtime。每个模块的 SOP 给出实施步骤，开发 Skill 供工程团队复用，示例包含配置、运行命令与预期结果。

## 从一项业务任务开始

1. 选一项能当场判定成败的任务。以资料整理为例，输入两版材料、一项已确认的格式偏好，输出带版本、出处的摘要。留一条已撤回资料和一个无授权身份做反例。
2. 接入只读知识源，先让四个入口找到同一条原文。需要跨会话使用偏好时，再接入 Hindsight，分别授予查询与管理权限。
3. 将整理方法写成 Skill，把保存摘要等实际动作注册为工具。由宿主决定谁能执行、使用哪个目录，以及用什么回执确认成功。
4. 有对象、关系或动作前提时，加载本体模型。让草稿和已复核资料走一遍相同的发布请求，分别核对拒绝时的零调用和成功时的业务回执。
5. 在三个独立会话里依次验证首次整理、复用偏好、更正偏好与撤回资料。现有组合例程运行真实 MCP、Skill、文件工具和本体引擎，知识索引、记忆后端和模型使用确定性夹具。业务交付还要在目标服务、模型、安装制品和业务样本上复跑。[组合示例](../../examples/modules/manage-ontology/README.zh-CN.md)

资料助手还在两个独立项目里用真实 Qwen、Qdrant/BGE-M3、Hindsight/PostgreSQL 和可选本体复跑了七个案例。验收记录附合成输入、首次失败、修复和摘要原文，可作为业务方准备自己用例的参照。[真实服务组合验收](../../examples/modules/manage-ontology/LIVE-COMPOSITION.zh-CN.md)

## 04 知识管理

[开发 SOP](../modules/manage-knowledge/SOP.zh-CN.md) · [开发 Skill](../../skills/manage-knowledge/SKILL.md) · [可运行示例及检索结果](../../examples/modules/manage-knowledge/README.zh-CN.md)

| 图谱子项 | 入口与已验证行为 | 业务方交付及边界 |
| --- | --- | --- |
| 04.01 资料接入与解析 | `docling_bridge.py` 用 Docling 与 RapidOCR 解析中文原生及扫描 PDF、表格 DOCX 和 Markdown，保留页码、章节或来源位置。 | 提供原件与预期单元格、段落或页码。按各格式实测定位精度。 |
| 04.02 知识组织与索引 | `knowledge_server.py --state` 保存文档身份和版本。重复导入保持幂等，同版本内容冲突被拒，重建失败保留旧索引。 | 提供清单、稳定 ID、版本、有效期和阅读范围。示例在进程内使用 Qdrant，重启依赖状态和原文重建。 |
| 04.03 检索排序与取证 | `search_knowledge` 在宿主指定范围内检索。30 道中文合成题中，关键词、稠密、稀疏、混合四种方法的前五条均命中 30/30，稀疏首条命中 30/30。 | 准备同义改写、精确编号、越权及无答案题。检索返回相似片段时仍需单独验证回答和引文。四入口对照用模型夹具驱动真实检索。 |
| 04.04 更新溯源与引用 | 宿主用 `--withdraw` 撤回版本。新检索排除该版本，`resolve_citation` 可区分有效、已撤回和未知引文。固定源码的独立安装验证包含两次从原文重建。[消费者验收](../modules/manage-knowledge/CLEAN-CONSUMER.zh-CN.md) | 提供版本替换、撤回权限和保留规则。每次重建后比对旧引文与新查询。 |

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

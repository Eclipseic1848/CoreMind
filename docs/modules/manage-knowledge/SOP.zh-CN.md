# 知识检索开发 SOP

1. 确认每份原文的稳定文档 ID、版本、有效期和阅读范围。选定一个具体问题，手工标出能回答它的原文位置，同时准备仅在旧版出现、仅对其他身份可见和资料缺失的反例。
2. 固定解析器、检索组件、模型和输入版本。仅将原文及来源元数据送入索引。将题目、参考短答、标注引文和三轮场景保存在评分端。
3. 用相同的问题、日期和阅读范围，从配置、TypeScript、Python 入口分别查询。对每个结果比对文档、版本、位置和摘录。用中文表格查找任务复核行与表头的对应关系。
4. 运行[固定集](../../../examples/knowledge-evals/zh-retrieval/README.zh-CN.md)的 30 道有答案题。统计首条及前五条命中数，保留错题编号与耗时，和同输入的 SQLite FTS5 基线对照。P1 的前五条命中参考目标为至少 27/30。
5. 对另外 10 道题检查过期及越权结果。对包含回答生成的系统，另外检查是否编造引文。无答案题也可能有相似片段。
6. 运行[模块清单](module.yaml)中的测试及 `npm run check:modules`。记录测试环境、资料摘要、组件版本、三个入口的引用和选型依据。
7. 增量与撤回验收：用 `--state` 连续启动两次，确认无变化；修改同版本内容，确认被拒绝；撤回一个当前版本，确认检索不再返回，旧引文返回 `withdrawn`；在重建注入失败时确认旧索引和状态文件保持不变。
8. 用两种读者身份回查同一历史引文。核对生效首日、到期当日及撤回后的结果。在状态文件替换失败时检查内存检索、原始引文和重启结果仍指向上一次成功版本。
9. 从当前源码安装后，使用[多片段回查示例](../../../examples/modules/manage-knowledge/README.zh-CN.md#回查同页或同节的片段)。从同一 PDF 页和 DOCX 节分别搜索多个片段，将每个命中的 `docId`、`version`、`file` 和 `chunkId` 送入 `resolve_citation`，逐字核对回查正文。重启后用同一引文复查。去掉 `chunkId` 再用共享的 `locator` 回查，预期 `ambiguous` 且无正文。旧位置唯一时仍应命中。撤回后以原读者复查 `withdrawn`，越权及失效时复查 `unknown`。

## 独立安装件验收

按[空白 TypeScript 项目示例](../../../examples/modules/manage-knowledge/README.zh-CN.md#从空白-typescript-项目直接查询)在仓库外接入知识服务。

| 检查 | 预期结果 |
| --- | --- |
| 直接检索与回查 | 用标准 MCP 客户端先调用 `search_knowledge`，再按引文身份调用 `resolve_citation`。比对文档 ID、版本、文件、位置和逐字正文。用公开 0.1.0 的 Markdown 行号作为基线。PDF、DOCX 的 `chunkId` 用含修复的源码构建件验收。 |
| 接入 Agent | 用同一地址、读令牌和问题运行已安装的 CoreMind TypeScript SDK。核对 Agent 的检索和回查工具调用，比对原文和来源。 |
| 权限、故障和停用 | 用无效令牌核对 HTTP 401。对照另一个阅读范围，确认检索结果排除受限文档，回查返回 `unknown`。停掉专用服务，验证调用明确失败。移除工具绑定后运行 Agent，记录零次知识工具调用。 |

1. 在仓库之外的空目录和新 Python 3.12 环境中，只安装指定版本的知识组件。验收 0.1.0 时运行 `python -m pip install coremind-knowledge-mcp==0.1.0`。记录安装来源、版本、制品摘要和启动入口。移开源码目录后，仍须能用业务清单、原文及固定模型启动。用普通 MCP 客户端核对缺少凭据时被拒，以及授权后的查询与引文，再验证实际项目使用的入口。
2. 首版迁移用 2.0.0 源码服务生成带有已撤回版本的真实状态。按指南的升级和回滚流程做前后对照。后续版本使用前一已发布安装件建立基线。
3. 卸除项目绑定及专用服务环境后，原项目其余功能仍能运行。核对保留的原文、状态文件与撤回记录。分别记录独立安装验收结果和既有源码回归结果。

在仓库外用已安装该 wheel 的解释器执行[迁移回归](../../../components/knowledge/tests/installed_lifecycle.py)，传入 `--console`、`--model-dir`、`--example` 和 `--legacy-archive`（正式 2.0.0 源码 ZIP）。它在临时业务目录创建实际旧状态，移开旧服务，验证标准 MCP 客户端、两种读者、版本替换及撤回，并在重建失败后重新启动旧服务核对最后提交的状态。

0.1.0 本地验收使用 Windows、Python 3.12.13 和 SHA-256 为 `de84e44f6d68dde7e85d63f21551ffe5add7b4d8bfbbbac98f90fb4f68f494ef` 的 wheel。下列结果使用合成资料和本机模型。

| 检查 | 结果 |
| --- | --- |
| 空白业务项目 | 只安装知识 wheel 及其依赖。普通 MCP 客户端回查第 3 行及其第 1 行表头。缺少凭据返回 401，另一范围的读者搜索为空、回查为 `unknown`。 |
| 迁移和回滚 | 用正式 2.0.0 源码生成旧目录。安装件保留原引文与撤回记录；未知撤回 ID 和超长块引发的失败均未改写上次提交。旧服务恢复后仍能回查新版本及两条撤回。 |
| 单项卸载 | 从另一套专用环境卸载已运行的 wheel 后，控制台和 Python 包消失，清单、原文、客户端示例和撤回状态四份文件摘要相同。业务侧仍可读取原始表格行。 |
| 检索与解析 | 固定集稀疏检索首条命中 30/30，10 道无答案题均仍有候选。在已有 Docling/RapidOCR 环境中用 wheel 解析 PDF 得 4 段、DOCX 得 3 段，核对扫描页和表格位置。 |

## 独立题集效果回归

从源码根目录执行 `python -B -X utf8 examples/knowledge-evals/zh-retrieval/answer_benchmark.py --replay --output knowledge.json`。固定集使用同一合成语料上的独立新题，索引不读取答题标注。检查 7 道正例的前五条召回、短答和准确引文，以及 6 道负例的明确拒答。首条命中、相似候选、错答与审核拦截分别记录。报告在评分失败时仍写出，便于按题号排查。[复跑与字段说明](../../../examples/knowledge-evals/zh-retrieval/README.zh-CN.md#独立题集离线回放)

## 部署与恢复验收

按[最小部署与恢复示例](../../../examples/modules/manage-knowledge/deployment/README.zh-CN.md)验收。在固定模型和 wheel 上，先核对重启前后的引文与撤回一致，再停机备份原文、清单和目录。换一个目录恢复并再次验证。记录启动和恢复耗时、模型和备份大小。用[安装件生命周期回归](../../../components/knowledge/tests/installed_lifecycle.py)分别记录升级和回退结果。

## 知识与记忆直调自动验收

先按两个示例准备仓库外的 TypeScript 和 Python 项目及各自的已安装依赖。由宿主启动真实的知识服务和 Hindsight 网关，为每项能力准备一个能命中预期正文的读者，再准备一个查询结果为空的有效读者。将以下 JSON 保存在仓库外的私有文件，替换相应地址、完整读令牌和预期正文。知识示例使用两组阅读范围，记忆示例使用同一网关中两个不同的记忆库。

```json
{
  "knowledge": {
    "url": "http://127.0.0.1:8767/mcp",
    "authorization": "Bearer <知识读令牌>",
    "query": "松纹卡",
    "expected": "银杏台",
    "other": { "url": "http://127.0.0.1:8768/mcp", "authorization": "Bearer <另一个知识读令牌>" }
  },
  "memory": {
    "url": "http://127.0.0.1:8769/mcp",
    "authorization": "Bearer <记忆读令牌>",
    "query": "资料摘要应该采用哪种格式？",
    "expected": "资料摘要优先使用表格。",
    "other": { "url": "http://127.0.0.1:8769/mcp", "authorization": "Bearer <另一个记忆读令牌>" }
  }
}
```

在源码根目录运行以下[验收脚本](../../../scripts/verify-direct-consumers.mjs)。第三个参数使用业务项目虚拟环境的 Python 解释器路径。

```sh
node scripts/verify-direct-consumers.mjs "<仓库外TS目录>" "<仓库外Python目录>" "<Python解释器路径>" "<私有JSON>"
```

脚本在回环地址启动确定性模型及 HTTP 503 夹具。每个组件分别验证直调、其它读者返回空、缺少凭据、无效凭据、服务不可用、同一服务绑定 Agent 和移除后仅运行 Runtime，输出各用例和总数。真实模型的生成质量另行验收。

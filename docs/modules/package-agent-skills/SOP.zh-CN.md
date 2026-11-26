# Skill 与 SOP 装载开发 SOP

固定版本安装使用当前 `coremind-templates` 安装件中的 `coremind-skill-install`。在独立项目核对锁和资源字节，再由目标 Agent 选择 Skill。安装及回退见[指南](GUIDE.zh-CN.md#固定版本安装和回退)。

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

从任务说明起草新 Skill 时，先在项目 `skills/` 之外运行[草稿生成示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)。负责人编辑 `SKILL.md`，用一个适用、一个不适用的任务核准触发条件和交付格式，审核后再复制进项目并选择其 ID。

1. 在配置目录 `skills/<id>/` 编写标准 `SKILL.md`，在 Agent 的 `skills` 中显式列出目录 ID。描述写适用条件，正文写步骤与检查项。按 [Agent Skills 规范](https://agentskills.io/specification) 组织 `references/`、`assets/`、`scripts/`，将包版本填入 `metadata.version`。旧项目可继续用 `README.md` 全文格式。
2. 按[资源包示例](GUIDE.zh-CN.md#编写资源包)声明相对路径和原始 UTF-8 字节的 SHA-256，统一 Git 行尾为 LF。单文件最多 256 KiB，解析结果和全部 Agent 冻结快照各最多 2 MiB 序列化 UTF-8 JSON。
3. 运行 `coremind check`，核对内置优先、双文件告警、损坏包、越界路径和链接。调用 `load_skill` 验证未声明资源会被拒绝。脚本源码可作为文本读取。要执行脚本，按项目工具注册、审批和沙箱流程单独授权。
4. 按[固定版本安装和回退](GUIDE.zh-CN.md#固定版本安装和回退)保存版本专属的内容锁。在两个干净配置目录分别安装和冻结重装，比较锁和已安装文件的 SHA-256。升级前保留上一份锁，注入一次资源篡改并核对旧版，随后演练回退。
5. 用匹配任务、无关任务和依赖缺失任务测试触发。核对首次模型请求只有索引。验证经 ToolPolicy 批准的 `load_skill({id})` 正文与 `load_skill({id, resource})` 资源进入请求，覆盖重复调用、压缩后重载和撤销权限后的拒绝。
6. 首次加载后修改或移走源文件，验证从旧运行恢复得到原版，新建 Runtime 得到当前版本。核对损坏或缺失快照明确失败，以及原始 Store 私有字段从公开投影、事件和遥测中剥离。完整请求重建仍需保留 Session 和压缩记录。
7. 完成[模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)的四入口验证和 `npm run check:modules`。运行[离线成对评测](../../../examples/modules/package-agent-skills/README.zh-CN.md#离线-skill-成对评测)，保留未见题、相近 Skill 和不该触发任务的回执。核对实际装载、任务达标和两组模拟 Token。真实模型效果单独用同题、同模型和同参数做开关对照，保存流程遵循、事实正确性、无关触发、延时与实际 Token 记录。发布前收集负责人确认。

单域验收先在业务方的最小配置中只选择一份 Skill。记录该包版本、提交或内容锁、被选中的 Agent 和一次实际读取结果。只更新这一份包，比较新 Runtime 与旧运行恢复时各自看到的版本，再撤销该 ID，确认新会话仍能完成普通对话。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。

## P2-C 验证记录

- Windows 上使用 Skills CLI 1.9.0 从固定 GitHub 提交安装两套示例 Skill，在第二个干净配置目录用原锁重装。交付检查包的五个文件逐字节验证一致。第二个目录安装后跑完四入口矩阵 20/20。回归还覆盖篡改拒绝、替换失败保留旧版、用同锁重试和版本回退。[已验证源提交](https://github.com/Eclipseic1848/CoreMind/commit/e4323b4b8e820e9495b42a1987a1f674f9caf448)
- 五道确定性用例经 CLI/YAML、TypeScript、Python 同步和异步入口通过 20/20。四次普通摘要都无 Skill 调用。冷恢复批准后读取原资源，拒绝后不再交付；新运行使用更新内容。已声明脚本可只读查看，执行哨兵未生成。
- 内网 `Qwen3.8-27B` 在温度 0、关闭思考、单回合输出上限 512 Token 的相同条件下做五题开关对照。首轮严格评分为启用 3/5、禁用 1/5，均包含零触发且内容正确的摘要。两道交付检查的业务结论正确，但启用组额外说明导致严格格式未过。明确 Skill 的输出格式后，用原题和原参数定向复验，启用 2/2、禁用 0/2，禁用两格均触及输出上限。启用组两格为 29.83 秒/4,151 Token 和 25.09 秒/4,234 Token。结果对应本次合成题和服务配置。[复现入口](../../../examples/modules/package-agent-skills/README.zh-CN.md)

# Skill 与 SOP 装载开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 在配置目录 `skills/<id>/` 编写标准 `SKILL.md`，在 Agent 的 `skills` 中显式列出目录 ID。描述写适用条件，正文写步骤与检查项。按 [Agent Skills 规范](https://agentskills.io/specification) 组织 `references/`、`assets/`、`scripts/`，将包版本填入 `metadata.version`。旧项目可继续用 `README.md` 全文格式。
2. 按[资源包示例](GUIDE.zh-CN.md#编写资源包)声明相对路径和原始 UTF-8 字节的 SHA-256，统一 Git 行尾为 LF。单文件最多 256 KiB，解析结果和全部 Agent 冻结快照各最多 2 MiB 序列化 UTF-8 JSON。
3. 运行 `coremind check`，核对内置优先、双文件告警、损坏包、越界路径和链接。调用 `load_skill` 验证未声明资源会被拒绝。脚本源码可作为文本读取。要执行脚本，按项目工具注册、审批和沙箱流程单独授权。
4. 按[固定版本安装和回退](GUIDE.zh-CN.md#固定版本安装和回退)保存版本专属的内容锁。在两个干净配置目录分别安装和冻结重装，比较锁和已安装文件的 SHA-256。升级前保留上一份锁，注入一次资源篡改并核对旧版，随后演练回退。
5. 用匹配任务、无关任务和依赖缺失任务测试触发。核对首次模型请求只有索引。验证经 ToolPolicy 批准的 `load_skill({id})` 正文与 `load_skill({id, resource})` 资源进入请求，覆盖重复调用、压缩后重载和撤销权限后的拒绝。
6. 首次加载后修改或移走源文件，验证从旧运行恢复得到原版，新建 Runtime 得到当前版本。核对损坏或缺失快照明确失败，以及原始 Store 私有字段从公开投影、事件和遥测中剥离。完整请求重建仍需保留 Session 和压缩记录。
7. 完成[模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)的四入口验证和 `npm run check:modules`。真实模型效果单独用同题、同模型和同参数做开关对照，保存流程遵循、事实正确性、无关触发、延时与 Token 记录。发布前收集负责人确认。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。

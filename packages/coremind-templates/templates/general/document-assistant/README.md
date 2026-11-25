# 资料整理助手

[English](README.en.md)

根据可见的资料版本生成带出处的摘要，按已确认的偏好选择表格或清单。业务方提供原文、身份对应的阅读范围和记忆库。需要核对发布条件时，可以接入自己的本体模型。

## 创建项目

使用包含此模板的 CoreMind CLI 和同版本的 Node、Python SDK。Node.js 需要 22.19 或更高版本。正式发布后的安装命令如下；候选验收时将安装来源换为同一候选的 tarball 与 wheel。

```sh
npx coremind-cli@2.0.0 create archive-desk --template document-assistant --language typescript --provider deepseek
cd archive-desk
npm install --save-exact coremind-ai@2.0.0 coremind-cli@2.0.0
python -m pip install coremind-ai==2.0.0
```

## 连接业务资料与记忆

| 服务 | 默认地址 | 由宿主准备 |
| --- | --- | --- |
| 知识 | `http://127.0.0.1:8767/mcp` | 登记资料版本和阅读范围，用 `COREMIND_KNOWLEDGE_AUTHORIZATION` 查询。[启动与导入](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-knowledge/README.zh-CN.md) |
| Hindsight 记忆 | `http://127.0.0.1:8769/mcp` | 将读者绑定到获准的记忆库，用 `COREMIND_MEMORY_AUTHORIZATION` 召回。由宿主在确认后记录、更正或遗忘偏好。[启动与确认偏好](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-memory/README.zh-CN.md) |
| 可选本体 | `http://127.0.0.1:8879/mcp` | 提供业务模型与约束，用 `COREMIND_ONTOLOGY_AUTHORIZATION` 查询动作前置条件。[启动与模型配置](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/modules/manage-ontology/GUIDE.zh-CN.md) |

第一次运行时，可为知识服务的 `--manifest` 指定[资料室演示清单](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-ontology/document-assistant-corpora/archive/manifest.json)。它含同一手册的两版原文和一份草稿表格。第二个项目可改用[蓝签资料清单](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-ontology/document-assistant-corpora/blue/manifest.json)，为两个服务配置各自的读取令牌。

在运行终端中注入模型密钥与两项只读服务令牌。每项服务令牌取宿主签发的完整 `Bearer <令牌>` 值。下例使用 PowerShell 7；Linux 也可用环境变量或部署平台的凭据注入。管理令牌仅由宿主服务持有。

```powershell
$env:DEEPSEEK_API_KEY = Read-Host 'DeepSeek API key' -MaskInput
$env:COREMIND_KNOWLEDGE_AUTHORIZATION = Read-Host '知识服务完整 Bearer 头' -MaskInput
$env:COREMIND_MEMORY_AUTHORIZATION = Read-Host '记忆服务完整 Bearer 头' -MaskInput
```

如需核对草稿发布条件，另注入本体只读令牌，按业务流程提供对象标识（如 `urn:doc:draft`）及动作名（如 `publish`）。运行 `node enable-ontology.mjs` 会按当前普通配置新建 `coremind-ontology.yaml`。两份配置各自独立；已有同名输出时会停止，保留手工改动。可在配置中修改服务地址和允许的地址。

## 运行四个入口

从生成的项目目录运行。将示例书名换成知识库中的资料名。下面四行分别演示同一任务，运行其中之一即可。每次成功写入都会更新本项目的 `summary.md`。

```powershell
$config = 'coremind.yaml'
$prompt = '比较《资料室手册》的两个版本，逐项引用文件、版本和位置，使用已确认的偏好，将摘要写入 summary.md。'
npx coremind run $config --prompt $prompt --session comparison
node run.mts $config $prompt
python -X utf8 run.py $config $prompt
python -X utf8 run.py --async $config $prompt
```

CLI 在互动终端展示写入审批。在 SDK 示例中，宿主只批准写入项目内的 `summary.md`。知识、记忆服务和 Skill 提供资料；模型无法通过本模板直接发布资料或管理记忆。

宿主确认「优先表格」后，在新会话整理另一份资料，核对表格和新引文。再将偏好更正为「优先清单」，撤回其中一个版本，从新会话确认清单与剩余版本的出处。要比较不同主体，请在各自项目目录启动，分别绑定服务读者和记忆库。验证本体时，把 `$config` 换成 `coremind-ontology.yaml`，再要求「检查 `urn:doc:draft` 的 `publish` 条件」。草稿应取得实际拒绝原因。资料不足时，摘要须指出缺少的证据。[资料比对 Skill](skills/document-comparison/SKILL.md)

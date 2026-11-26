# 知识组件的最小部署与恢复

此示例使用 Python 3.12、公开的 `coremind-knowledge-mcp==0.1.0` 和本地 BGE-M3。知识服务监听回环地址，使用进程内 Qdrant。它仅依赖模型文件、业务原文及状态文件，只启用知识时无需启动其他组件或为模型 API 配置凭据。

## 启动并验证

在仓库外创建部署目录。在其下的 `business/` 放入[示例清单](../../../../components/knowledge/example/manifest.json)、[`sources/desk.md`](../../../../components/knowledge/example/sources/desk.md)和[查询脚本](../../../../components/knowledge/example/query.py)，保持相同的相对路径。用部署目录下单独的 Python 虚拟环境安装指定制品。虚拟环境和 BGE-M3 目录都放在 `business/` 外。模型修订及校验见[固定 BGE-M3 模型](../README.zh-CN.md#准备检索模型并复跑固定集)。

在服务和查询终端注入同一个 `COREMIND_KNOWLEDGE_AUTHORIZATION`，完整值为 `Bearer ` 加至少 24 个字符的随机读令牌。读者范围由宿主配置。在 `business/` 启动服务，将模型路径改为本地绝对路径。

```sh
python -m pip install coremind-knowledge-mcp==0.1.0
coremind-knowledge-mcp --version
coremind-knowledge-mcp --manifest manifest.json --model-dir "/absolute/model-dir" --state state/catalog.json --scope records
```

在另一终端用带读令牌的健康检查确认服务已就绪，再验证真实引文。

```sh
python -X utf8 -c "import json,os,urllib.request as u; r=u.Request('http://127.0.0.1:8767/health',headers={'Authorization':os.environ['COREMIND_KNOWLEDGE_AUTHORIZATION']}); print(json.load(u.build_opener(u.ProxyHandler({})).open(r,timeout=5)))"
python -X utf8 query.py "松纹卡"
```

健康检查返回 `ready`。查询和回查都应指向 `desk.md` 第 3 行，显示“银杏台”和第 1 行表头。另一组读者范围使用独立端点、令牌和每进程独占的状态路径。

## 停机备份、恢复与回退

1. 在服务终端按 Ctrl+C，确认进程退出。记录 wheel 版本和摘要、BGE-M3 修订、端口和读者范围。备份范围包含 `manifest.json`、`sources/` 和 `state/catalog.json`。凭据留在宿主环境。
2. 在 `business/` 的父目录执行下面的复制命令。恢复目录应尚不存在。用原来的模型、端口和范围在 `restored/` 重新运行启动命令。

   ```sh
   python -X utf8 -c "from shutil import copytree; copytree('business','backups/knowledge-before-change')"
   python -X utf8 -c "from shutil import copytree; copytree('backups/knowledge-before-change','restored')"
   ```

3. 对照健康、原文、版本、位置和撤回状态，全部相符后再切换应用连接。Qdrant 索引每次启动重建，恢复的权威数据是原文、清单和目录文件。由旧快照恢复时，先核对并重新应用快照之后发生的撤回，随后开放读取。
4. 升级时把新 wheel 安装到另一个环境，只对状态副本试跑。回退时用原环境打开已核对的副本，保留新版本期间的业务撤回，复验后再接回应用。停用时移除应用的 MCP 绑定，撤销对应读令牌，再关闭该进程。

## 自动验收

从源码根目录用 Python 3.12 执行。将 `--console` 指向已安装的 `coremind-knowledge-mcp` 入口，在 Windows 上使用虚拟环境 `Scripts/coremind-knowledge-mcp.exe`，在 Linux 上使用 `bin/coremind-knowledge-mcp`。脚本在临时目录生成两份合成文档，启停三次并恢复到新的目录。它检查 HTTP 401、原件回查、撤回后无正文和备份字节一致，报告就绪、查询、复制耗时、备份与模型字节数。

```sh
python -B -X utf8 examples/modules/manage-knowledge/deployment/verify.py --console "/absolute/coremind-knowledge-mcp" --model-dir "/absolute/model-dir"
```

另用[安装件生命周期测试](../../../../components/knowledge/tests/installed_lifecycle.py)复验 2.0.0 源码服务与已安装独立知识组件之间的迁移和回退。两套验收见[知识 SOP](../../../../docs/modules/manage-knowledge/SOP.zh-CN.md)。

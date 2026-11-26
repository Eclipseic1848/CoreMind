# CoreMind Memory MCP

`coremind-memory-mcp` 0.1.0 为标准 Streamable HTTP MCP 客户端提供经授权的 Hindsight 记忆查询。业务应用只持读令牌。宿主独立运行 Hindsight OSS 1.2.3、PostgreSQL、网关进程及记忆库绑定。

在新的 Python 3.12 环境中从 PyPI 安装。

```sh
python -m pip install coremind-memory-mcp==0.1.0
```

需要从源码安装时，可在源码根目录构建并安装本地 wheel。

```sh
python -m pip wheel --no-deps ./components/memory --wheel-dir dist
python -m pip install ./dist/coremind_memory_mcp-0.1.0-py3-none-any.whl
```

准备宿主绑定文件和已存在的状态目录，在服务终端注入其引用的独立读、管理令牌。单个进程独占回执文件。

```sh
coremind-memory-mcp --hindsight-url http://127.0.0.1:8780 --config memory-host.json --state memory-receipts.json --port 8769
```

标准客户端连接 `http://127.0.0.1:8769/mcp`，使用 `Authorization: Bearer …`，可见工具为 `recall_memory(query)`。宿主通过 `/admin/retain`、`/admin/correct`、`/admin/reflect`、`/admin/forget` 和 `/admin/forget-bank` 管理其获准的库。后端密钥可由 `COREMIND_HINDSIGHT_API_KEY` 注入。部署配置与生命周期测试见[中文示例](https://github.com/Eclipseic1848/CoreMind/tree/main/examples/modules/manage-memory)和[升级 SOP](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/modules/manage-memory/SOP.zh-CN.md)。

The 0.1.0 wheel runs independently of the CoreMind CLI and SDKs. Install `coremind-memory-mcp==0.1.0` from PyPI in a dedicated Python 3.12 environment, or use the optional source wheel commands above. Set up the host bindings, state directory and separate reader and administrator tokens before starting the service. The application receives only its reader token. See the [standalone example](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-memory/README.en.md) and [upgrade procedure](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/modules/manage-memory/SOP.en.md).

当前源码构建的网关支持给已确认经验登记同库依据的文档 ID 和版本。宿主经 `/admin/retain`、`/admin/correct` 提交 `evidence`，经 `/admin/review-status` 查询待复核经验。依据更正或遗忘后，相关经验暂停召回，宿主复核并提交有效依据后再生效。[中文复核步骤](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/modules/manage-memory/GUIDE.zh-CN.md#按依据版本确认和复核经验)

A gateway built from the current source supports evidence IDs and versions for confirmed experiences. Use `/admin/retain` and `/admin/correct` to send `evidence` and `/admin/review-status` to list experiences awaiting review. Correcting or forgetting evidence suspends recall of the affected experiences until the host reviews them and submits valid evidence. [Review procedure](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/modules/manage-memory/GUIDE.en.md#confirm-and-review-an-experience-by-evidence-version)

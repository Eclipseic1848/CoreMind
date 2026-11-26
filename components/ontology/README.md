# CoreMind Ontology MCP

`coremind-ontology-mcp` 0.1.0 是独立的本体服务，支持 Python 3.10 及以上版本。使用业务方自己的 Turtle、SHACL、映射与动作定义，通过 Streamable HTTP MCP 查询对象、校验来源记录和检查动作前置条件。默认只读。无需 CoreMind SDK、模型凭据、知识库或记忆服务。

在业务目录激活独立虚拟环境，从 PyPI 安装本体服务，并将业务模型放在环境外。

```sh
python -m pip install coremind-ontology-mcp==0.1.0
coremind-ontology-mcp --version
coremind-ontology-mcp --model-dir /absolute/path/to/model --port 8879
```

需要从源码安装时，可在包含 `pyproject.toml` 的本目录构建并安装本地 wheel。

```sh
python -m pip wheel --no-deps . --wheel-dir dist
python -m pip install dist/coremind_ontology_mcp-0.1.0-py3-none-any.whl
```

启动前，由宿主设置 `COREMIND_ONTOLOGY_AUTHORIZATION` 为完整的 `Bearer <token>`，令牌至少 24 个无空白字符。客户端向 `http://127.0.0.1:8879/mcp` 传相同的 Authorization Header。模型目录包含经审阅的 `model.ttl`、`shapes.ttl`、`data.ttl`、`mapping.json` 和 `actions.json`。只读模型的 `actions` 可为空。查询结果携带模型版本及摘要。

写操作需另设不同的 `COREMIND_ONTOLOGY_ACTION_AUTHORIZATION`，并给服务传入 `--action-handler /path/to/handler.py --receipt-db /path/to/receipts.sqlite3`。宿主明确指定的本地 Python 文件提供同步 `execute(command)`。处理器按 `requestId` 幂等执行，返回 `requestId`、`resource`、`previousState`、`status` 和 `state`。服务将完成回执与预期后态核对。回执未知时保留原请求并阻止同对象的新写入。每个业务项目独占一份回执库，轮换模型或组件时先停止旧服务。保留模型、回执库和业务系统记录后，可用 `python -m pip uninstall coremind-ontology-mcp` 卸除组件。

The wheel runs as an independent loopback MCP service. Install `coremind-ontology-mcp==0.1.0` from PyPI in a dedicated environment, or use the optional source wheel commands above. Supply an external model directory and start the console command above. Read and action tokens are distinct. An approved business handler and a durable SQLite receipt database are required for writes. Stop the old process before switching models or component versions. Keep the model, receipt database and business records outside the environment when uninstalling.

The repository contains the [Chinese integration guide](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/modules/manage-ontology/GUIDE.zh-CN.md), [English integration guide](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/modules/manage-ontology/GUIDE.en.md) and [runnable example](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-ontology/README.en.md).

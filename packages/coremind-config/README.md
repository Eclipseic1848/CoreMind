# coremind-config

CoreMind 的配置解析与校验包。它负责读取 `coremind.yaml`、应用默认值，并在智能体开始执行前返回可定位的配置错误。

```ts
import { loadConfig } from "coremind-config";

const config = await loadConfig("coremind.yaml");
```

适合框架扩展者直接使用；普通应用建议安装统一入口包 `coremind-ai`。完整配置说明见[项目文档](https://github.com/Eclipseic1848/CoreMind/tree/main/docs/guide)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)

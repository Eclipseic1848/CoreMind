# coremind-worker

CoreMind 的本地 Node.js Worker，通过标准输入输出协议向 Python SDK 提供与 TypeScript 入口一致的运行能力。

该包通常由 Python 构建流程自动打包和调用，不建议业务代码直接启动。协议消息写入标准输入，业务日志必须写入标准错误，避免破坏消息通道。

跨语言一致性由黄金样例和 Wheel 安装测试共同验证，包括显式 Loop 的状态顺序、暂停恢复与终态。详见[Python 嵌入模块](https://github.com/Eclipseic1848/CoreMind/tree/main/docs/modules/embed-coremind-python)。

工具注册必须携带结构化副作用；初始化或注册失败时 Python 客户端会关闭 Worker，避免遗留子进程。

协议能力声明包含 `loop`；`resume_run` 可继续安全的暂停或意外中断运行，但不会绕过配置指纹、Effect Receipt 或副作用核对。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)

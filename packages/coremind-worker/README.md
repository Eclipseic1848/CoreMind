# coremind-worker

CoreMind 的本地 Node.js Worker，通过标准输入输出协议向 Python SDK 提供与 TypeScript 入口一致的运行能力。

该包通常由 Python 构建流程自动打包和调用，不建议业务代码直接启动。协议消息写入标准输入，业务日志必须写入标准错误，避免破坏消息通道。

跨语言一致性由黄金样例和 Wheel 安装测试共同验证。详见[Python 嵌入模块](https://github.com/Eclipseic1848/CoreMind/tree/main/docs/modules/embed-coremind-python)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)

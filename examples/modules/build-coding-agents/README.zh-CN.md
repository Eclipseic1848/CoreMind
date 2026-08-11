# 编码智能体模块示例

本模块提供两个会被复制到临时 Git 仓库运行的真实单文件缺陷样例，并在同一门禁中执行 Engineering Kernel 跨文件场景：

- [TypeScript 折扣计算缺陷](../../coding-evals/typescript-defect)
- [Python 税费计算缺陷](../../coding-evals/python-defect)

## Windows 确定性验证

```powershell
npm run build
npm run test:coding-evals
```

预期：6 个 Case 全部通过。两个真实缺陷样例先观察目标测试失败，再完成最小修改并通过目标与完整回归测试；TypeScript/Python 各自还验证跨文件修复、写前 checkpoint、Diff、Restore、错误命令、审批拒绝和中止。`user-notes.txt` 与配置/环境示例保持原样。

## 真实模型验证

真实模型会产生费用并发送样例代码，必须先获得数据外发授权并配置密钥。仓库维护者可运行 `npm run eval:coding-real -- --repetitions 5`；普通项目不需要把它作为日常单元测试。

完整步骤见 [中文指南](../../../docs/modules/build-coding-agents/GUIDE.zh-CN.md) 和 [示例说明](../../coding-evals/README.zh-CN.md)。

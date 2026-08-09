# 编码智能体模块示例

本模块提供两个会被复制到临时 Git 仓库运行的真实缺陷样例：

- [TypeScript 折扣计算缺陷](../../coding-evals/typescript-defect)
- [Python 税费计算缺陷](../../coding-evals/python-defect)

## Windows 确定性验证

```powershell
npm run build
npm run test:coding-evals
```

预期：两个样例全部通过；每个样例先观察一次目标测试失败，再完成一次最小修改，最终目标测试和完整回归测试均通过。`user-notes.txt` 与配置/环境示例保持原样。

## 真实模型验证

真实模型会产生费用并发送样例代码，必须先获得数据外发授权并配置密钥。仓库维护者可运行 `npm run eval:coding-real -- --repetitions 5`；普通项目不需要把它作为日常单元测试。

完整步骤见 [中文指南](../../../docs/modules/build-coding-agents/GUIDE.zh-CN.md) 和 [示例说明](../../coding-evals/README.zh-CN.md)。

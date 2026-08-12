# Runtime 依赖 Adapter 上手指南

## 普通用户怎么用

普通用户不需要配置 Adapter。升级或安装后运行：

```powershell
coremind doctor .\coremind.yaml
```

看到“Runtime 兼容层”通过，表示当前发行版认可的依赖族、能力和错误映射已加载；这不是一次真实模型认证。

## 维护者怎么验证

```powershell
npm ci --ignore-scripts
npm run build
npm run dependencies:check
npm run baseline:check
```

然后运行模块清单中的 Provider、工具、Session、usage、错误和超时测试。Linux sandbox 的安装脚本和真实隔离测试必须在 Linux 门禁中单独执行，不能用 Windows 结果代替。

## 升级原则

1. 先在独立候选上统一所有核心版本，不做混搭。
2. 先运行合同测试，再删除兼容强转。
3. Provider 清单变化只代表可配置范围变化；旧认证证据不会自动继承到新增 Provider 或新版本。
4. 更新候选基线必须写明迁移、兼容和回滚原因，参考基线保持不可变。
5. 若 Session、消息或工具协议不能无损适配，整体回退到旧版本族。

## 常见误区

- `doctor` 通过不等于 API key 或真实模型请求成功。
- Provider 数量增加不等于新增 Provider 已认证。
- 不要用 `as unknown as` 把两个版本的工具类型强行拼接。
- 不要给 SDK 生成会覆盖用户依赖解析的 shrinkwrap。

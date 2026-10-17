# 工具与业务能力开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 先定义输入 JSON Schema、`effect.operations`、`effect.reversible` 和幂等策略；不确定时使用 `external` 与 `false`。
2. 用确定性代码实现，不把业务规则藏进提示词。
3. 覆盖成功、非法参数、依赖失败和重复调用。
4. 为非标准路径/URL 字段填写 `pathFields`/`urlFields`，为写操作确认权限与真实恢复能力，并确认工具名不与内置工具冲突。
5. 子进程只使用命令和参数数组；设置超时、输出上限、中止信号和最小环境变量集合。显式 `env` 必须作为权威输入，不得与宿主密钥合并，也不得被工具执行上下文覆盖。
6. Git 读取只使用 `GitAdapter` 固定接口；需要写 Git 状态时停止并取得单独授权。
7. Diff 在读取和计算前设置文件、输出与复杂度上限，并拒绝工作区外或链接逃逸路径。
8. 在 Linux CI 中验证 bash 不能越界写入或联网；保持串行执行，避免共享沙箱清理器并发互扰。
9. 在 Windows 验证受约束模式拒绝宿主 Shell，只有明确开放的三项条件同时满足时才执行；分别覆盖 Git Bash、PowerShell 回退和显式最小环境。
10. 运行模块列出的测试，并执行 `npm run check:modules`。
11. 保存 Trace、评测和人工确认记录；未经明确授权不发布。

## 本地 MCP 的附加验收

按[配置指南](../../guide/02-configuration.md#mcp按-agent-选择本地工具)确认程序、目录、参数和环境引用。先做零启动的静态诊断，再验证连接、目录、业务三个阶段各自拒绝与允许，检查完整 schema、审批身份、秘密阻断、未知效果和真实进程回收。保持受限项目质量门；不为受信宿主程序增加豁免。

固定 Job 程序集或启动器的维护者在受控 Windows 环境分别执行 `node scripts/build-windows-mcp-service.mjs --rebuild-guard` 或 `node scripts/build-windows-mcp-service.mjs --rebuild-host`，审查对应 C#、Framework csc/三项引用摘要及生成 DLL/EXE；修改哪份源码就必须重新编译对应资产，不能只更新收据。两份源码同时变化时须显式同时传入 `--rebuild-guard --rebuild-host`。普通构建、`--check`、`--copy-only` 与 `--python-assets` 只验证和复制冻结资产，Linux 不需要编译器。再运行原 Windows Job 与 MCP 全回归、原 15 秒/60 秒门禁以及 npm、wheel、源码 ZIP 安装检查；预取消、owner 死亡、全部后代退出和未知清理失败的断言保持。编译来源记录不承诺不同编译器下的逐次字节确定性，也不代替真实平台验收。

## 受控 HTTP MCP 的附加验收

1. 按[HTTP 配置](../../guide/02-configuration.md#mcp受控-http-与精确资源授权)固定 URL 和 Header 引用。确认认证环境变量含完整 Header 值；凭据缺失、401/403 不回退身份，不进入 OAuth 或刷新。
2. 分别验证默认公网 HTTPS、非空 `allowedAddresses` 对全部地址的精确约束、显式 loopback HTTP、非法地址拒绝、DNS 与实际 socket 绑定。重定向和环境代理不得带出凭据；静态诊断不联网。
3. 对 HTTP 网络元操作分别测 `network: allow` 的配置批准、`network: ask` 的原审批和 deny 的零发送。业务 Effect/Capability、工作区限制、预算、关键 barrier 和收据保持同一 Harness。
4. 资源按 Agent 精确原 URI 授权，覆盖默认/空集合不继承、仅 HTTP、list/templates/read、分页、猜 URI 和响应夹带 URI。仅资源首模型前零 HTTP，仅工具零资源请求；不解引用本地文件或链接，不接受 blob。
5. 在真实请求已进入后注入取消、断流、401/403/408/429/5xx、坏正文和限额故障。覆盖 8 MiB body、64 MiB owner、32 页/256 条、30 秒总期限及 owner 最多 3 GET/30 秒；取消单请求不能关闭其他合法调用，写后丢响应不能重发业务 POST。
6. 检查模型请求、Facts/query/events、Artifact、CLI 和 Worker JSON 都没有凭据原文。Run 结束须先验证本地 body/socket/dispatcher 已收敛，再做测试夹具兜底清理；远端 session 由服务租约管理，不发送 DELETE。
7. 运行清单中的 TypeScript、CLI、Python 同步/异步及旧 Worker 拒绝回归；保留原 stdio 测试。分别记录工作区、安装制品、平台和真实外部互通证据，未运行的形态不得标为通过。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。

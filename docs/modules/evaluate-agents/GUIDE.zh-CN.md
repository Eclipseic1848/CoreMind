# 测试、评测与质量门禁上手指南

## 什么时候使用

分离运行成功、指标、业务评测和发布判断，并用可重复场景阻止失败伪装成通过。

## 最小业务文本示例（兼容 schemaVersion 1）

```text
schemaVersion: 1
scenarios:
  - id: paid-order
    input: 查询订单 A-100
    expected:
      contains:
        - 已支付
      notContains:
        - TODO
```

## 多证据示例（推荐 schemaVersion 2）

```yaml
schemaVersion: 2
scenarios:
  - id: repair-discount
    input: 复现并修复折扣计算错误
    repetitions: 3
    graders:
      - { id: outcome, type: outcome, status: succeeded }
      - type: trajectory
        sequence:
          - { tool: bash, result: failed }
          - { tool: read, result: succeeded }
          - { tool: edit, result: succeeded }
          - { tool: bash, result: succeeded }
        maxToolFailures: 1
      - type: command
        command: node
        args: ["--test"]
      - type: file
        path: src/discount.ts
        contains: ["Math.min"]
      - type: diff
        requiredPaths: ["src/discount.ts"]
        allowedPaths: ["src/discount.ts"]
        preserveExisting: true
      - type: state
        maxTurns: 12
        maxApprovals: 0
        maxSecurityFindings: 0
      - type: response
        contains: ["src/discount.ts", "测试"]
```

七类 grader 分别验证终态、工具轨迹、命令、文件、Git 差异、运行状态和最终回答。评测前会记录文件与脏工作区基线；评测命令不通过 Shell 拼接，路径不得逃逸工作区。

## 轻量实验

```ts
const experiment = defineExperiment({
  id: "context-strategy",
  version: "1",
  seed: "team-approved-seed",
  arms: [
    { id: "baseline", weight: 1 },
    { id: "candidate", weight: 1, config: { compact: true } },
  ],
});

const record = await runExperiment({
  definition: experiment,
  inputFingerprint: "sha256:fixture-a",
  environment,
  run: async (arm) => executeAndGrade(arm),
});
```

`ExperimentRecord` 保存分配哈希、arm、环境、运行终态、指标、完整 Trace 和 grader。真实输入应先生成不可逆指纹；不要把敏感原文写入实验台账。

## 双版本配对评测（仓库维护者入口）

先取得可信的稳定版完整发布 bundle，并在清洁的固定候选提交上运行 `npm run candidate:bundle`。两者都必须保留 `release-manifest.json` 引用的全部制品；不能只凭版本号选择产物，也不能重建旧源码冒充原发布包。

用实际清单字节计算 SHA-256，并用协调器本身的算法固定共同夹具：

```sh
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update(readFileSync('/absolute/bundle/release-manifest.json')).digest('hex'))"
node --input-type=module -e "import {fingerprintTree} from './scripts/run-paired-evaluation.mjs'; console.log(await fingerprintTree('examples/coding-evals'))"
```

将以下占位内容替换为实际绝对路径、清单摘要和提交，保存为 `paired-input.json`。`outputDirectory` 使用新的输出目录。

```json
{
  "schemaVersion": 1,
  "arms": [
    { "id": "baseline", "artifactRoot": "/absolute/stable-bundle", "manifestSha256": "<实际64位清单SHA-256>", "commit": "<稳定版实际提交>" },
    { "id": "candidate", "artifactRoot": "/absolute/candidate-bundle", "manifestSha256": "<实际64位清单SHA-256>", "commit": "<候选实际提交>" }
  ],
  "fixtures": { "root": "/absolute/CoreMind/examples/coding-evals", "sha256": "<上述夹具摘要>" },
  "cases": ["typescript-defect", "python-defect"],
  "repetitions": 3,
  "outputDirectory": "/absolute/new-paired-report"
}
```

```sh
npm run eval:paired -- --input paired-input.json
```

协调器先固定两场景×两臂×三次的完整计划，按 AB/BA 顺序交替执行。每臂将清单中的八个 npm 包一次安装到独立目录，记录真实锁文件、安装树及入口摘要；每格使用独立进程与工作区，复用现有 grader。安装准备需要可信 Registry 或缓存；评测使用本地模拟服务，不需要付费 Provider。

输出的 `plan.json`、`results.jsonl`、`report.json` 分别保留计划、逐格终态和聚合结果。准备失败、异常退出、非法输出和超时也入账；缺格、重复、身份不符或安全失败不能得到合格结论。不完整配对及失败占位 0 不参与性能胜负，缺失指标保留 `null` / unavailable。

导入、CLI 轻入口启动、Worker 初始化、正常 EOF、流消费与取消分别记录。新进程的模块冷启动不代表操作系统磁盘冷缓存；热态测同一已预热 Worker 内的独立新 Run，单列观测。流探针除取消会话验证外关闭 Session 持久化。慢消费作用于真实 Worker 输出管道，不表示模型服务被逐级反压。本地 SSE 延迟、合成用量不能充当真实模型 TTFT、费用、缓存收益或业务质量证明；没有明确收益时如实保留结果，不生成自动通过复核。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/evaluate-agents/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 对代码修改同时检查目标测试、完整回归、允许文件列表和既有脏文件指纹。
6. 对实验重复运行同一固定任务集，比较成功率、工具失败、审批、成本与恢复证据，不能追着结果修改权重或门槛。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
- 不要把首次复现测试的预期失败误判为安全漏洞；安全发现与不可自动回退警告必须分开。
- 不要让自动复核冒充业务负责人或发布负责人签字。

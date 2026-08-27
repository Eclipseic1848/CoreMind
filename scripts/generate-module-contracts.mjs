import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const version = JSON.parse(await readFile("package.json", "utf8")).version;

const modules = [
  moduleOf({
    id: "configure-coremind",
    zh: "配置与 Schema",
    en: "Configuration and Schema",
    purposeZh: "用一份可校验的 coremind.yaml 描述 Agent、工具、工作流、预算、权限和质量档。",
    purposeEn:
      "Describe agents, tools, workflows, budgets, permissions, and quality profiles in one validated coremind.yaml file.",
    source: ["packages/coremind-config/src"],
    tests: [
      "packages/coremind-config/src/parse.test.ts",
      "packages/coremind-config/src/validate.test.ts",
    ],
    dependencies: [],
    interfaces: ["loadConfigFile", "parseConfigText", "parseAndValidate", "validateConfig"],
    errorsZh: [
      "ConfigParseError：文件或 YAML/JSON 语法无效",
      "ConfigValidationError：配置不符合 v2 Schema",
    ],
    errorsEn: [
      "ConfigParseError: unreadable file or invalid YAML/JSON",
      "ConfigValidationError: configuration does not satisfy the v2 schema",
    ],
    stepsZh: [
      "先写 schemaVersion、name 和 agents",
      "显式选择 runtime、permissions 和 quality",
      "运行 coremind check，再处理全部错误与告警",
      "业务字段不明确时停止并询问负责人",
    ],
    stepsEn: [
      "Define schemaVersion, name, and agents first",
      "Select runtime, permissions, and quality explicitly",
      "Run coremind check and resolve every error and warning",
      "Stop and ask the owner when business fields are unknown",
    ],
    example:
      "schemaVersion: 2\nname: support-agent\nagents:\n  main:\n    systemPrompt: 你是客服助手\npermissions:\n  mode: ask\n  workspaceOnly: true\n  network: ask\nruntime:\n  maxTurns: 12\nquality:\n  profile: standard",
  }),
  moduleOf({
    id: "manage-providers",
    zh: "Provider 与模型",
    en: "Providers and Models",
    purposeZh: "继承锁定运行时依赖的 Provider 清单，并把“可选”与“经过真实认证”严格分开。",
    purposeEn:
      "Inherit the provider catalog from the locked runtime dependency while keeping availability separate from real certification.",
    source: [
      "packages/coremind-runtime/src/provider.ts",
      "packages/coremind-cli/src/commands/list-providers.ts",
      "scripts/certify-provider.mjs",
      "scripts/provider-certification.mjs",
      "scripts/provider-matrix-lib.mjs",
    ],
    tests: [
      "packages/coremind-runtime/src/provider.test.ts",
      "packages/coremind-runtime/src/integration.real.test.ts",
      "packages/coremind-cli/src/commands/create.test.ts",
      "scripts/provider-certification.test.ts",
      "scripts/provider-matrix.test.ts",
    ],
    dependencies: ["configure-coremind"],
    interfaces: [
      "buildProviderRuntime",
      "listInheritedProviders",
      "listSupportedProviders",
      "coremind providers",
    ],
    errorsZh: ["未知 Provider 或模型会拒绝启动", "缺少 apiKeyEnv 时会给出明确鉴权错误"],
    errorsEn: [
      "Unknown providers or models prevent startup",
      "A missing apiKeyEnv produces an explicit authentication error",
    ],
    stepsZh: [
      "先列出当前锁定版本继承的 Provider",
      "优先使用 apiKeyEnv，不把密钥写入 YAML",
      "用离线 mock 验证契约",
      "仅在真实流式、工具、多轮和错误测试通过后标记认证",
    ],
    stepsEn: [
      "List providers inherited from the locked version",
      "Use apiKeyEnv and never store secrets in YAML",
      "Verify contracts with an offline mock",
      "Mark certification only after real streaming, tool, multi-turn, and error tests pass",
    ],
    example: "provider:\n  id: deepseek\n  model: deepseek-chat\n  apiKeyEnv: DEEPSEEK_API_KEY",
  }),
  moduleOf({
    id: "adapt-runtime-dependencies",
    zh: "Runtime 依赖 Adapter",
    en: "Runtime Dependency Adapters",
    purposeZh:
      "统一关键运行依赖版本，并用 CoreMind 私有 Adapter 隔离消息、工具、Usage、错误和 Session 实现。",
    purposeEn:
      "Align critical runtime versions and isolate message, tool, usage, error, and Session implementations behind private CoreMind adapters.",
    source: [
      "packages/coremind-runtime/src/dependency-adapter.ts",
      "packages/coremind-runtime/src/session.ts",
      "packages/coremind-runtime/src/provider.ts",
      "packages/coremind-tools/src/registry.ts",
      "scripts/dependency-report.mjs",
    ],
    tests: [
      "scripts/dependency-lockstep.test.ts",
      "scripts/dependency-report.test.ts",
      "packages/coremind-runtime/src/dependency-adapter.test.ts",
      "packages/coremind-runtime/src/session.test.ts",
      "packages/coremind-runtime/src/provider.test.ts",
      "packages/coremind-tools/src/registry.test.ts",
    ],
    dependencies: ["manage-providers", "build-tools", "manage-sessions"],
    interfaces: ["inspectRuntimeCompatibility"],
    errorsZh: ["依赖版本混搭时阻断构建", "消息、工具或会话合同无法无损适配时整体回退"],
    errorsEn: [
      "Mixed dependency versions block the build",
      "The complete family rolls back when message, tool, or Session contracts cannot be adapted losslessly",
    ],
    stepsZh: [
      "冻结参考版本、候选版本和整体回滚点",
      "先写依赖唯一性与行为合同失败测试",
      "统一精确版本并在私有 Adapter 中完成转换",
      "运行依赖、Provider、工具、Session 与候选基线门禁",
    ],
    stepsEn: [
      "Freeze the reference version, candidate version, and whole-family rollback point",
      "Write failing version-uniqueness and behavior-contract tests first",
      "Align exact versions and keep conversions inside private adapters",
      "Run dependency, Provider, tool, Session, and candidate-baseline gates",
    ],
    example:
      "const report = inspectRuntimeCompatibility();\nif (!report.capabilities.streaming) throw new Error('Runtime incompatible');",
    maturity: "alpha",
  }),
  moduleOf({
    id: "recover-durable-runs",
    zh: "持久运行与故障恢复",
    en: "Durable Runs and Recovery",
    purposeZh:
      "用单一 operation 外围状态、原子 RunState、版本化 Session、Checkpoint 与 Effect Receipt 明确恢复边界，避免重复副作用和伪恢复。",
    purposeEn:
      "Define recovery boundaries with one operation envelope, atomic RunState, versioned sessions, checkpoints, and effect receipts so side effects are not replayed or falsely recovered.",
    source: [
      "packages/coremind-runtime/src/operation-state.ts",
      "packages/coremind-runtime/src/run-state.ts",
      "packages/coremind-runtime/src/session.ts",
      "packages/coremind-runtime/src/checkpoint.ts",
      "packages/coremind-runtime/src/run-effect-coordinator.ts",
      "packages/coremind-runtime/src/snapshot.ts",
      "packages/coremind-runtime/src/runtime.ts",
    ],
    tests: [
      "packages/coremind-runtime/src/operation-state.test.ts",
      "packages/coremind-runtime/src/run-state.test.ts",
      "packages/coremind-runtime/src/session-conformance.test.ts",
      "packages/coremind-runtime/src/session.test.ts",
      "packages/coremind-runtime/src/checkpoint.test.ts",
      "packages/coremind-runtime/src/run-effect-coordinator.test.ts",
      "packages/coremind-runtime/src/snapshot.test.ts",
      "packages/coremind-runtime/src/runtime.test.ts",
      "packages/coremind-worker/src/server.test.ts",
    ],
    dependencies: [
      "design-workflows",
      "manage-sessions",
      "manage-checkpoints",
      "inspect-agent-traces",
    ],
    interfaces: [
      "DurableOperation",
      "restoreDurableOperation",
      "FileRunStore",
      "prepareRunResume",
      "CoreMindSession",
      "RunResult.operation",
    ],
    errorsZh: [
      "非法、重复或乱序 operation 事件会失败关闭",
      "未知或已提交但未稳定归属的副作用必须人工判定，不会自动重放",
      "旧 Session 迁移前自动备份；不能无损转换时保留原文件",
      "RunState 锁冲突、序号冲突和不可修复损坏均返回稳定错误",
    ],
    errorsEn: [
      "Illegal, duplicate, or out-of-order operation events fail closed",
      "Unknown or committed effects without stable ownership require human review and are never replayed automatically",
      "Legacy sessions are backed up before migration and kept unchanged when lossless conversion is impossible",
      "RunState lock conflicts, sequence conflicts, and unrecoverable corruption return stable errors",
    ],
    stepsZh: [
      "为运行分配 runId、operationId 和 correlationId",
      "按 accepted、running、paused、aborting、completed 或 failed 合法迁移",
      "把对话、运行、副作用和用量分别交给唯一权威存储",
      "在工具执行前创建 Checkpoint 和 started Effect Receipt",
      "恢复时先检查终态、稳定步骤与副作用收据，再决定重试、跳过或人工处理",
      "迁移旧 Session 前校验、备份并注入失败测试",
    ],
    stepsEn: [
      "Assign runId, operationId, and correlationId",
      "Use only legal accepted, running, paused, aborting, completed, or failed transitions",
      "Give conversation, run, side-effect, and usage state one authoritative owner each",
      "Create a checkpoint and started effect receipt before tool execution",
      "Before recovery, inspect terminal state, stable steps, and effect receipts to retry, skip, or request human review",
      "Validate, back up, and failure-test every legacy Session migration",
    ],
    example:
      'coremind run coremind.yaml --prompt "执行任务" --json-events\ncoremind run coremind.yaml --resume <runId> --json-events',
    maturity: "alpha",
  }),
  moduleOf({
    id: "manage-context-artifacts",
    zh: "上下文与 Artifact 治理",
    en: "Context and Artifact Governance",
    purposeZh:
      "用稳定 Provider 前缀、可审计的确定性压缩、真实缓存计量和受控大输出 Artifact 保持长任务可用且不泄漏秘密。",
    purposeEn:
      "Keep long-running tasks usable without leaking secrets through a stable provider prefix, auditable deterministic compaction, truthful cache metrics, and controlled large-output artifacts.",
    source: [
      "packages/coremind-runtime/src/context.ts",
      "packages/coremind-runtime/src/agent-factory.ts",
      "packages/coremind-runtime/src/events.ts",
      "packages/coremind-runtime/src/result.ts",
      "packages/coremind-tools/src/artifact-store.ts",
    ],
    tests: [
      "packages/coremind-runtime/src/context.test.ts",
      "packages/coremind-runtime/src/result.test.ts",
      "packages/coremind-tools/src/artifact-store.test.ts",
      "packages/coremind-tools/src/registry.test.ts",
    ],
    dependencies: ["manage-sessions", "build-tools", "inspect-agent-traces"],
    interfaces: [
      "buildStableContextPrefix",
      "protectContext",
      "compareContextStrategies",
      "ArtifactStore",
      "wrapToolWithArtifactCapture",
      "RunMetrics.context",
      "RunMetrics.artifacts",
    ],
    errorsZh: [
      "压缩异常时保留原消息并发出失败事件，不静默丢失上下文",
      "不受信任的完整输出路径会被丢弃，不会被读取或删除",
      "疑似凭据不会进入模型预览或 Artifact 文件",
      "缓存能力未由模型目录声明时标为 unavailable，零命中不会伪造成命中",
    ],
    errorsEn: [
      "Compaction failures preserve the original messages and emit a failure event",
      "Untrusted full-output paths are discarded without reading or deleting them",
      "Suspected credentials never enter model previews or artifact files",
      "Cache support is unavailable unless declared by model metadata, and zero usage is never reported as a hit",
    ],
    stepsZh: [
      "按固定分区和排序生成稳定上下文前缀并记录指纹",
      "在每次 Provider 请求前检查阈值并只使用本地确定性摘要",
      "在摘要中保留目标、约束、审批、改动、测试、未完成任务和不确定副作用",
      "把超大工具输出流式导入工作区受控 Artifact 目录",
      "向模型仅返回有界头尾预览、摘要、哈希和相对引用",
      "比较压缩策略指标后再调整默认值，禁止自动创建项目记忆",
    ],
    stepsEn: [
      "Build a stable context prefix with fixed sections and ordering, then record its fingerprint",
      "Check thresholds before every provider request and use only a local deterministic summary",
      "Preserve goals, constraints, approvals, changes, tests, incomplete work, and uncertain effects",
      "Stream large tool output into the controlled workspace artifact directory",
      "Return only a bounded head-tail preview, summary, hash, and relative reference to the model",
      "Compare strategy metrics before changing defaults and never create project memory automatically",
    ],
    example:
      "const store = new ArtifactStore({ cwd: process.cwd() });\nconst comparison = compareContextStrategies(messages, options);",
    maturity: "alpha",
  }),
  moduleOf({
    id: "design-agents",
    zh: "Agent 构建",
    en: "Agent Construction",
    purposeZh: "把聚焦的系统提示、模型选项、工具和技能构造成独立 Agent 实例。",
    purposeEn:
      "Build isolated agent instances from a focused system prompt, model options, tools, and skills.",
    source: [
      "packages/coremind-runtime/src/agent-factory.ts",
      "packages/coremind-runtime/src/runtime.ts",
    ],
    tests: [
      "packages/coremind-runtime/src/agent-factory.test.ts",
      "packages/coremind-runtime/src/runtime.test.ts",
    ],
    dependencies: ["configure-coremind", "manage-providers", "build-tools", "package-agent-skills"],
    interfaces: ["buildAgent", "CoreMindRuntime.create", "buildAgentFromConfig"],
    errorsZh: [
      "unknown_agent：指定 Agent 不存在",
      "agent_failed：上游 stopReason:error 或模型失败",
    ],
    errorsEn: [
      "unknown_agent: the selected agent does not exist",
      "agent_failed: upstream stopReason:error or model failure",
    ],
    stepsZh: [
      "为 Agent 写单一职责和非目标",
      "只挂载完成职责所需的工具",
      "先用单 Agent 通过场景测试",
      "只有职责确实分离时再增加 Agent",
    ],
    stepsEn: [
      "Write one responsibility and explicit non-goals",
      "Attach only tools required for that responsibility",
      "Pass scenarios with one agent first",
      "Add agents only when responsibilities are genuinely separate",
    ],
    example:
      "agents:\n  main:\n    systemPrompt: |\n      只根据订单工具返回的数据回答；缺失信息时明确说明。\n    tools:\n      - id: read",
  }),
  moduleOf({
    id: "extend-runtime-lifecycle",
    maturity: "beta",
    zh: "Runtime 生命周期扩展",
    en: "Runtime Lifecycle Extensions",
    purposeZh:
      "通过四个只读生命周期事件、显式信任清单和逐项能力授权扩展 Runtime，同时保持权限、Checkpoint 与真实终态不可绕过。",
    purposeEn:
      "Extend the Runtime through four read-only lifecycle events, an explicit trust list, and per-capability grants without bypassing permissions, checkpoints, or truthful terminal states.",
    source: [
      "packages/coremind-runtime/src/lifecycle-extension.ts",
      "packages/coremind-runtime/src/runtime.ts",
      "packages/coremind-runtime/src/events.ts",
    ],
    tests: [
      "packages/coremind-runtime/src/lifecycle-extension.test.ts",
      "packages/coremind-runtime/src/runtime.test.ts",
    ],
    dependencies: [
      "enforce-agent-permissions",
      "manage-checkpoints",
      "inspect-agent-traces",
      "recover-durable-runs",
    ],
    interfaces: [
      "defineLifecycleExtension",
      "LifecycleExtensionHost",
      "createTraceExporterExtension",
      "createDenyPolicyExtension",
      "CoreMindRuntimeOptions.lifecycleExtensions",
    ],
    errorsZh: [
      "未显式信任或能力未完整授权的扩展拒绝加载",
      "扩展超时或异常只产生收据，不能改写真正终态",
      "before-tool 只能附加拒绝，不能授予通用权限已经拒绝的操作",
      "项目目录中的未知扩展不会被自动扫描或加载",
    ],
    errorsEn: [
      "Extensions that are not explicitly trusted or fully granted are rejected",
      "Timeouts and failures produce receipts but cannot rewrite the true terminal state",
      "before-tool may only add a denial and cannot grant an operation rejected by the shared policy",
      "Unknown project-local extensions are never scanned or loaded automatically",
    ],
    stepsZh: [
      "只选择 before-model、before-tool、after-tool 或 run-finished 中确有必要的事件",
      "声明文件、进程、网络、凭据和 UI 能力，并由宿主逐项授权",
      "将扩展 id 加入显式信任清单，设置短超时并保留执行收据",
      "用同步、异步、超时、异常、审批拒绝和终态不可伪造 Case 验证",
      "不把项目本地代码自动提升为可信扩展，也不把扩展建设成第二套 Runtime",
    ],
    stepsEn: [
      "Choose only the required before-model, before-tool, after-tool, or run-finished event",
      "Declare file, process, network, credential, and UI capabilities and grant each explicitly",
      "Add the extension id to the trust list, set a short timeout, and retain execution receipts",
      "Test sync, async, timeout, failure, approval denial, and terminal-state integrity cases",
      "Never auto-promote project-local code to a trusted extension or build a second Runtime",
    ],
    example:
      "const extension = createDenyPolicyExtension({ id: 'deny-shell', deniedTools: ['bash'] });\nconst runtime = await CoreMindRuntime.create({ ...options, lifecycleExtensions: { extensions: [extension], trustedIds: ['deny-shell'], grants: { 'deny-shell': extension.capabilities }, timeoutMs: 500 } });",
  }),
  moduleOf({
    id: "build-coding-agents",
    maturity: "beta",
    zh: "编码智能体",
    en: "Coding Agents",
    purposeZh: "把复现缺陷、定位原因、最小修改、目标测试、回归测试和差异审查固化为受控流程。",
    purposeEn:
      "Turn defect reproduction, diagnosis, minimal repair, target tests, regression tests, and diff review into a controlled workflow.",
    source: [
      "packages/coremind-tools/src/process-runner.ts",
      "packages/coremind-tools/src/git-adapter.ts",
      "packages/coremind-tools/src/unified-diff.ts",
      "packages/coremind-runtime/src/evaluation-graders.ts",
      "packages/coremind-runtime/src/coding/engineering-kernel.ts",
      "packages/coremind-runtime/src/coding/runtime-engineering-evidence.ts",
      "examples/coding-evals",
    ],
    tests: [
      "packages/coremind-tools/src/process-runner.test.ts",
      "packages/coremind-tools/src/git-adapter.test.ts",
      "packages/coremind-tools/src/unified-diff.test.ts",
      "packages/coremind-runtime/src/evaluation.test.ts",
      "packages/coremind-runtime/src/batch8-properties.test.ts",
      "packages/coremind-runtime/src/coding/engineering-kernel.test.ts",
      "packages/coremind-runtime/src/coding/runtime-engineering-evidence.test.ts",
      "examples/coding-evals/coding-evals.test.ts",
      "examples/coding-evals/engineering-kernel.test.ts",
    ],
    dependencies: [
      "design-agents",
      "build-tools",
      "evaluate-agents",
      "enforce-agent-permissions",
      "manage-checkpoints",
    ],
    interfaces: [
      "ProcessRunner",
      "GitAdapter",
      "createUnifiedDiff",
      "runEvaluationSuite",
      "EvaluationGrader",
      "inspectCodingRepository",
      "selectCodingEnvironment",
      "createEngineeringTaskPlan",
      "createEngineeringKernelDefinition",
      "EngineeringEvidenceLedger",
      "loop.verify.evidence",
    ],
    errorsZh: [
      "无法复现缺陷时停止修改",
      "工作区越界、未授权网络和受保护文件修改会被拒绝",
      "既有脏工作区默认必须保持原样",
      "测试、grader 或安全门禁失败时不得声明完成",
      "语言、包管理器或测试命令存在歧义时必须由用户选择",
    ],
    errorsEn: [
      "Editing stops when the defect cannot be reproduced",
      "Workspace escape, unauthorized network access, and protected-file edits are rejected",
      "Pre-existing dirty-worktree content is preserved by default",
      "Failed tests, graders, or security gates prevent completion claims",
      "Language, package-manager, or test-command ambiguity requires an explicit user choice",
    ],
    stepsZh: [
      "记录分支、脏工作区和受保护文件基线",
      "只把仓库探测作为建议，并由用户确认语言、包管理器与测试命令",
      "用最小目标测试复现失败",
      "定位根因并只做最小修改",
      "依次运行目标与完整回归测试",
      "审查 Git 状态、差异、Trace、Checkpoint 和 grader",
    ],
    stepsEn: [
      "Record the branch, dirty worktree, and protected-file baseline",
      "Treat repository detection as a suggestion and ask the user to confirm language, package manager, and test command",
      "Reproduce the failure with the smallest target test",
      "Locate the cause and make only the smallest repair",
      "Run target tests followed by the complete regression suite",
      "Review Git status, diff, trace, checkpoints, and graders",
    ],
    example:
      "npm run build\nnpm run test:coding-evals\ncoremind eval coremind.yaml --suite evals/scenarios.yaml --json",
  }),
  moduleOf({
    id: "build-tools",
    zh: "工具与业务能力",
    en: "Tools and Business Capabilities",
    purposeZh: "通过内置工具、脚本工具或稳定 defineTool 契约连接确定性的业务动作。",
    purposeEn:
      "Connect deterministic business actions through built-in tools, script tools, or the stable defineTool contract.",
    source: [
      "packages/coremind-tools/src",
      "packages/coremind-tools/src/linux-sandbox.ts",
      "packages/coremind-tools/src/process-runner.ts",
      "packages/coremind-tools/src/git-adapter.ts",
      "packages/coremind-tools/src/unified-diff.ts",
      "packages/coremind-runtime/src/public-tool.ts",
    ],
    tests: [
      "packages/coremind-tools/src/registry.test.ts",
      "packages/coremind-tools/src/linux-sandbox.test.ts",
      "packages/coremind-tools/src/process-runner.test.ts",
      "packages/coremind-tools/src/git-adapter.test.ts",
      "packages/coremind-tools/src/unified-diff.test.ts",
      "packages/coremind-runtime/src/public-tool.test.ts",
    ],
    dependencies: ["configure-coremind", "enforce-agent-permissions", "manage-checkpoints"],
    interfaces: [
      "buildTools",
      "defineTool",
      "adaptCoreMindTool",
      "ProcessRunner",
      "GitAdapter",
      "createUnifiedDiff",
      "diffFiles",
    ],
    errorsZh: [
      "工具加载失败会告警并跳过",
      "工具异常会进入 tool_result 与失败预算",
      "越权路径或 deny 规则会阻止执行",
      "Linux bash 沙箱初始化失败时关闭执行，不回退到宿主 shell",
      "子进程、只读 Git 和统一 Diff 均使用超时、输出、路径与复杂度上限",
    ],
    errorsEn: [
      "Tool loading failures are warned and skipped",
      "Tool exceptions enter tool_result and failure budgets",
      "Escaped paths or deny rules block execution",
      "Linux bash fails closed when sandbox initialization fails and never falls back to the host shell",
      "Subprocesses, read-only Git, and unified diffs enforce timeout, output, path, and complexity limits",
    ],
    stepsZh: [
      "先定义输入 JSON Schema、副作用和幂等策略",
      "用确定性代码实现，不把业务规则藏进提示词",
      "覆盖成功、非法参数、依赖失败和重复调用",
      "为写操作确认权限与恢复能力",
      "在 Linux CI 中验证 bash 不能越界写入或联网",
      "保持 Linux bash 串行执行，避免共享沙箱清理器并发互扰",
      "验证子进程环境隔离、Git 只读边界与 Diff 大小上限",
    ],
    stepsEn: [
      "Define the input JSON Schema, side effects, and idempotency strategy",
      "Implement deterministic code instead of hiding rules in prompts",
      "Cover success, invalid input, dependency failure, and repeated calls",
      "Confirm permission and recovery behavior for writes",
      "Verify in Linux CI that bash cannot write outside the workspace or access the network",
      "Keep Linux bash execution sequential so shared sandbox cleanup cannot race",
      "Verify subprocess environment isolation, read-only Git boundaries, and diff limits",
    ],
    example:
      "const lookupOrder = defineTool({\n  name: 'lookup_order',\n  description: '按编号查询模拟订单',\n  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },\n  effect: { operations: ['read'], reversible: true },\n  execute: async ({ id }) => ({ id, status: 'paid' }),\n});",
  }),
  moduleOf({
    id: "package-agent-skills",
    zh: "Skill 与 SOP 装载",
    en: "Skill and SOP Loading",
    purposeZh: "把可复用的专业流程写成精简 Skill，并按 Agent 配置注入，业务事实仍由项目文档提供。",
    purposeEn:
      "Package reusable procedures as concise skills and inject them per agent while keeping business facts in project documentation.",
    source: ["packages/coremind-templates/src/skills.ts", "packages/coremind-templates/skills"],
    tests: ["packages/coremind-templates/src/skills.test.ts"],
    dependencies: ["configure-coremind"],
    interfaces: ["resolveSkills", "loadDirectorySkills", "SKILLS"],
    errorsZh: ["缺失 Skill 会告警并继续，不会伪装成已加载", "同名时内置 Skill 优先"],
    errorsEn: [
      "Missing skills warn and continue without pretending to load",
      "Built-in skills take precedence on name collisions",
    ],
    stepsZh: [
      "在 frontmatter 写清触发场景",
      "正文只保留不可凭常识推断的步骤",
      "把详细参考放到一层 references",
      "运行格式验证并用真实任务复核",
    ],
    stepsEn: [
      "Describe trigger contexts in frontmatter",
      "Keep only non-obvious procedure in the body",
      "Move detailed material into one-level references",
      "Validate the format and exercise it on a real task",
    ],
    example:
      "agents:\n  reviewer:\n    systemPrompt: 你是代码审查助手\n    skills:\n      - code-review",
  }),
  moduleOf({
    id: "design-workflows",
    zh: "Workflow 与受控 Loop",
    en: "Workflows and Bounded Loops",
    purposeZh:
      "在静态 Workflow 与显式 verify/repair Loop 之间做清晰选择，用有界状态、稳定快照和 Effect Receipt 阻止伪成功与副作用重放。",
    purposeEn:
      "Choose clearly between static workflows and explicit verify-repair loops, using bounded state, stable snapshots, and effect receipts to prevent false success and side-effect replay.",
    source: [
      "packages/coremind-runtime/src/orchestrator.ts",
      "packages/coremind-runtime/src/loop-controller.ts",
      "packages/coremind-runtime/src/loop-runner.ts",
      "packages/coremind-runtime/src/retry-policy.ts",
      "packages/coremind-config/src/schema/workflow.ts",
      "packages/coremind-config/src/schema/loop.ts",
    ],
    tests: [
      "packages/coremind-runtime/src/orchestrator.test.ts",
      "packages/coremind-runtime/src/loop-controller.test.ts",
      "packages/coremind-runtime/src/loop-runner.test.ts",
      "packages/coremind-runtime/src/retry-policy.test.ts",
      "packages/coremind-runtime/src/budget.test.ts",
      "examples/golden/golden-examples.test.ts",
    ],
    dependencies: ["design-agents", "inspect-agent-traces"],
    interfaces: [
      "Orchestrator",
      "LoopController",
      "LoopRunner",
      "evalCondition",
      "RunBudgetController",
      "prepareRunResume",
      "fingerprintRunConfig",
    ],
    errorsZh: [
      "步骤超时、未知 Agent、重试耗尽和总步骤超限均明确失败",
      "验证失败必须进入修复、暂停或失败；达到最大迭代、最大修复或无进展阈值时不得成功",
      "恢复只发生在稳定状态；committed 副作用不重放，unknown 副作用必须暂停人工核对",
      "并发步骤使用独立 Agent 实例",
      "未完成步骤调用过非重放安全工具时以 unsafe_resume 拒绝自动恢复",
    ],
    errorsEn: [
      "Step timeout, unknown agent, exhausted retries, and step-budget overflow fail explicitly",
      "Verification failure must repair, pause, or fail; iteration, repair, and no-progress exhaustion cannot succeed",
      "Resume occurs only at stable states; committed effects are not replayed and unknown effects require human review",
      "Parallel steps use isolated agent instances",
      "Automatic resume fails with unsafe_resume when an incomplete step called a non-replay-safe tool",
    ],
    stepsZh: [
      "先画清输入输出依赖",
      "固定依赖使用 workflow；需要生成、验证、修复闭环时才使用 loop",
      "确定性操作留在工具或普通代码",
      "设置 passIf、maxIterations、maxRepairs、maxRepeatedAction 和耗尽策略",
      "分别注入验证失败、审批拒绝、瞬态错误、无进展、预算耗尽和进程中断",
      "检查状态序列、Effect Receipt、稳定快照和恢复后未重复副作用",
    ],
    stepsEn: [
      "Map input and output dependencies",
      "Use workflow for fixed dependencies and loop only for a generate-verify-repair cycle",
      "Keep deterministic operations in tools or normal code",
      "Set passIf, maxIterations, maxRepairs, maxRepeatedAction, and the exhaustion policy",
      "Inject verification failure, denied approval, transient errors, no progress, budget exhaustion, and process interruption",
      "Inspect state order, effect receipts, stable snapshots, and the absence of side-effect replay after resume",
    ],
    example:
      "loop:\n  execute:\n    agent: coder\n    input: '{{prompt}}'\n  verify:\n    agent: reviewer\n    input: '{{candidate.text}}'\n    passIf: '{{text}} == PASS'\n  repair:\n    agent: coder\n    input: '{{verification.text}}'\n  maxIterations: 3\n  maxRepairs: 2\n  maxRepeatedAction: 2\n  onFailure: repair\n  onExhausted: fail",
  }),
  moduleOf({
    id: "manage-sessions",
    zh: "Session 与 Context",
    en: "Sessions and Context",
    purposeZh: "保存多轮消息、严格恢复损坏错误，并在 Provider 调用前进行确定性的上下文保护。",
    purposeEn:
      "Persist multi-turn messages, fail clearly on corrupt recovery, and protect context deterministically before provider calls.",
    source: [
      "packages/coremind-runtime/src/session.ts",
      "packages/coremind-runtime/src/chat-session.ts",
      "packages/coremind-runtime/src/context.ts",
    ],
    tests: [
      "packages/coremind-runtime/src/session.test.ts",
      "packages/coremind-runtime/src/chat-session.test.ts",
      "packages/coremind-runtime/src/context.test.ts",
    ],
    dependencies: ["design-agents", "inspect-agent-traces"],
    interfaces: ["CoreMindSession", "ChatSession", "ContextProtector"],
    errorsZh: [
      "session_restore_failed：会话损坏时停止，不静默新建",
      "上下文压缩保留最近完整轮次并产生事件",
    ],
    errorsEn: [
      "session_restore_failed: stop on corruption instead of silently starting over",
      "Context compaction preserves recent complete turns and emits an event",
    ],
    stepsZh: [
      "只为需要续聊的场景开启 Session",
      "使用安全 sessionId",
      "验证恢复后只追加新消息",
      "观察 context_compacted 事件",
      "对损坏文件做失败注入",
    ],
    stepsEn: [
      "Enable sessions only when continuity is required",
      "Use a safe sessionId",
      "Verify restored sessions append only new messages",
      "Observe context_compacted events",
      "Inject a corrupt-file failure",
    ],
    example: "session:\n  enabled: true\n  dir: ./.coremind/sessions\n  compact: false",
  }),
  moduleOf({
    id: "enforce-agent-permissions",
    zh: "权限与安全",
    en: "Permissions and Security",
    purposeZh:
      "统一执行 ask、assisted、full 三档审批，并明确区分路径感知文件工具、Linux bash OS 沙箱和 Windows shell 风险边界。",
    purposeEn:
      "Enforce ask, assisted, and full approval modes while distinguishing path-aware file tools, the Linux bash OS sandbox, and Windows shell risk boundaries.",
    source: [
      "packages/coremind-runtime/src/tool-policy.ts",
      "packages/coremind-runtime/src/runtime.ts",
      "packages/coremind-runtime/src/agent-factory.ts",
      "packages/coremind-cli/src/approval.ts",
      "packages/coremind-tools/src/linux-sandbox.ts",
      "packages/coremind-tools/src/host-shell.ts",
    ],
    tests: [
      "packages/coremind-runtime/src/tool-policy.test.ts",
      "packages/coremind-runtime/src/runtime.test.ts",
      "packages/coremind-cli/src/approval.test.ts",
      "packages/coremind-tools/src/linux-sandbox.test.ts",
      "packages/coremind-tools/src/host-shell.test.ts",
    ],
    dependencies: ["configure-coremind", "inspect-agent-traces"],
    interfaces: [
      "ToolPolicy",
      "ApprovalQueue",
      "ToolApprovalRequest",
      "createLinuxSandboxedBashTool",
    ],
    errorsZh: [
      "没有审批处理器时安全拒绝",
      "显式 deny 与路径感知文件工具的越界路径在 full 下也不会放行",
      "任意 shell 副作用不承诺自动回退",
      "Linux bash 当前默认拒绝网络，沙箱不可用时关闭执行",
      "Windows 宿主 Shell 只有 full、关闭工作区限制和允许网络同时满足时开放",
    ],
    errorsEn: [
      "Missing approval handlers deny safely",
      "Explicit deny and escaped paths for path-aware file tools remain blocked in full mode",
      "Arbitrary shell side effects are never claimed as automatically reversible",
      "Linux bash currently denies network access and fails closed when the sandbox is unavailable",
      "The Windows host shell opens only when full mode, open workspace access, and allowed network are all selected",
    ],
    stepsZh: [
      "默认从 ask 开始",
      "列出允许与禁止的工具",
      "对网络单独选择 ask、allow 或 deny；注意当前 Linux bash 仍固定断网",
      "用真实工具验证三档模式",
      "不得把 full 解释为关闭审计或 checkpoint",
      "Windows shell 没有 OS 沙箱；验证三项开放条件与 Git Bash 兼容性边界",
    ],
    stepsEn: [
      "Start with ask by default",
      "List allowed and denied tools",
      "Choose ask, allow, or deny for network tools while noting that Linux bash remains offline",
      "Verify all three modes with real tools",
      "Never interpret full as disabling audit or checkpoints",
      "Verify the three Windows opening conditions and treat Git Bash as compatibility rather than isolation",
    ],
    example:
      "permissions:\n  mode: assisted\n  workspaceOnly: true\n  network: deny\n  deny:\n    - bash",
  }),
  moduleOf({
    id: "manage-checkpoints",
    zh: "Checkpoint、Diff 与恢复",
    en: "Checkpoints, Diffs, and Restore",
    purposeZh:
      "在 edit/write 前保存文件快照，提供 diff 和显式恢复；无法保证的副作用明确标记不可逆。",
    purposeEn:
      "Snapshot files before edit/write, expose diff and explicit restore, and mark unguaranteed side effects as non-reversible.",
    source: ["packages/coremind-runtime/src/checkpoint.ts"],
    tests: [
      "packages/coremind-runtime/src/checkpoint.test.ts",
      "packages/coremind-runtime/src/runtime.test.ts",
    ],
    dependencies: ["enforce-agent-permissions", "inspect-agent-traces"],
    interfaces: ["CheckpointManager", "inspectCheckpoint", "restoreCheckpoint"],
    errorsZh: [
      "checkpoint_too_large：超出快照上限时阻止修改",
      "checkpoint_not_reversible：拒绝伪恢复",
      "checkpoint_corrupt：记录无效",
    ],
    errorsEn: [
      "checkpoint_too_large: block a write that exceeds the snapshot limit",
      "checkpoint_not_reversible: refuse fake recovery",
      "checkpoint_corrupt: invalid record",
    ],
    stepsZh: [
      "执行写工具前确认 checkpoint_created",
      "用 diff 检查实际变化",
      "仅在用户明确要求时恢复",
      "对 bash 和自定义工具按不可逆副作用处理",
    ],
    stepsEn: [
      "Confirm checkpoint_created before a write",
      "Inspect the actual change with diff",
      "Restore only after an explicit user request",
      "Treat bash and custom tools as non-reversible side effects",
    ],
    example: "/checkpoints\n/diff CHECKPOINT_ID\n/restore CHECKPOINT_ID",
  }),
  moduleOf({
    id: "inspect-agent-traces",
    zh: "Trace、RunState 与调试",
    en: "Trace, RunState, and Debugging",
    purposeZh:
      "用带 runId、eventId、sequence 和 timestamp 的脱敏事件及 append-only RunState 保存可复核证据，并生成安全恢复计划。",
    purposeEn:
      "Preserve reviewable evidence through redacted events carrying runId, eventId, sequence, and timestamp plus append-only RunState, and derive safe resume plans.",
    source: [
      "packages/coremind-runtime/src/trace.ts",
      "packages/coremind-runtime/src/run-state.ts",
      "packages/coremind-runtime/src/events.ts",
    ],
    tests: [
      "packages/coremind-runtime/src/run-state.test.ts",
      "packages/coremind-runtime/src/runtime.test.ts",
      "packages/coremind-runtime/src/trace.test.ts",
    ],
    dependencies: ["configure-coremind"],
    interfaces: [
      "TraceRecorder",
      "RunStateJournal",
      "FileRunStore",
      "CoreMindEvent",
      "prepareRunResume",
    ],
    errorsZh: [
      "损坏或断序 JSONL 会报告 run_state_corrupt",
      "已结束运行不可重复恢复",
      "配置指纹、输入或非重放安全副作用不匹配时拒绝恢复",
      "事件严格递增，审批、预算和 checkpoint 进入同一 Trace",
      "凭据字段、正文、命令中的敏感参数和 URL 密钥在持久化前隐藏",
    ],
    errorsEn: [
      "Corrupt or discontinuous JSONL reports run_state_corrupt",
      "Finished runs cannot be resumed again",
      "Resume is rejected for mismatched config fingerprints, input, or non-replay-safe side effects",
      "Events increase monotonically and include approvals, budgets, and checkpoints in one trace",
      "Credential fields, bodies, command secrets, and URL secrets are redacted before persistence",
    ],
    stepsZh: [
      "先按 runId 定位运行",
      "按 sequence 重建时间线",
      "从第一个 fatal error 或 policy_denied 向前检查",
      "确认 step_output 是完整稳定边界后再恢复",
      "用事件证据复现后再修改",
      "确认 Trace 与 RunState 不包含测试凭据或正文原文",
      "保留修复前后 Trace",
    ],
    stepsEn: [
      "Locate the run by runId",
      "Rebuild the timeline by sequence",
      "Inspect backward from the first fatal error or policy_denied",
      "Resume only after confirming a complete step_output boundary",
      "Reproduce from evidence before changing code",
      "Confirm Trace and RunState do not contain test credentials or raw bodies",
      "Keep before-and-after traces",
    ],
    example:
      "runtime = await CoreMindRuntime.create({\n  config,\n  configDir,\n  trace: (entry) => console.log(entry.sequence, entry.event.type),\n});",
  }),
  moduleOf({
    id: "evaluate-agents",
    zh: "测试、评测与质量门禁",
    en: "Testing, Evaluation, and Quality Gates",
    purposeZh: "分离运行成功、指标、业务评测和发布判断，并用可重复场景阻止失败伪装成通过。",
    purposeEn:
      "Separate runtime outcome, metrics, business evaluation, and release readiness while preventing failures from masquerading as passes.",
    source: [
      "packages/coremind-runtime/src/evaluation.ts",
      "packages/coremind-runtime/src/evaluation-graders.ts",
      "packages/coremind-runtime/src/project-check.ts",
      "packages/coremind-runtime/src/result.ts",
      "packages/coremind-runtime/src/experiment.ts",
    ],
    tests: [
      "packages/coremind-runtime/src/evaluation.test.ts",
      "packages/coremind-runtime/src/batch8-properties.test.ts",
      "packages/coremind-runtime/src/project-check.test.ts",
      "packages/coremind-runtime/src/quality.test.ts",
      "examples/coding-evals/coding-evals.test.ts",
      "packages/coremind-runtime/src/experiment.test.ts",
    ],
    dependencies: ["inspect-agent-traces", "enforce-agent-permissions"],
    interfaces: [
      "checkProject",
      "runEvaluationSuite",
      "RunOutcome",
      "EvaluationReport",
      "ReleaseReadiness",
      "EvaluationGrader",
    ],
    errorsZh: [
      "安全门禁不可覆盖",
      "非安全门禁只有在 allowOverride 和明确原因同时存在时才能覆盖，并追加写入 .coremind/quality-overrides.jsonl",
      "审计写入失败时拒绝覆盖",
      "strict 场景至少重复三次",
      "schemaVersion 2 强制 outcome grader，并保护既有脏工作区",
    ],
    errorsEn: [
      "Security gates cannot be overridden",
      "Non-security gates require allowOverride plus an explicit reason and append a record to .coremind/quality-overrides.jsonl",
      "An audit-write failure rejects the override",
      "Strict scenarios run at least three times",
      "schemaVersion 2 requires an outcome grader and preserves the dirty-worktree baseline",
    ],
    stepsZh: [
      "先定义业务成功条件",
      "为正常、边界、失败和拒绝建立场景",
      "按风险配置 trajectory、command、file、diff、state 与 response grader",
      "运行 coremind check",
      "运行 coremind eval",
      "只根据 ReleaseReadiness 决定是否进入发布",
    ],
    stepsEn: [
      "Define business success first",
      "Create happy, boundary, failure, and denial scenarios",
      "Select trajectory, command, file, diff, state, and response graders according to risk",
      "Run coremind check",
      "Run coremind eval",
      "Use ReleaseReadiness—not a fluent answer—to decide release",
    ],
    example:
      "schemaVersion: 2\nscenarios:\n  - id: paid-order\n    input: 查询订单 A-100\n    graders:\n      - { type: outcome, status: succeeded }\n      - { type: response, contains: [已支付], notContains: [TODO] }\n      - { type: state, maxSecurityFindings: 0 }",
  }),
  moduleOf({
    id: "operate-coremind-cli",
    zh: "CLI 与 TUI",
    en: "CLI and TUI",
    purposeZh:
      "通过 create、run、chat、check、eval、doctor 和 templates 完成新手端到端开发路径，并用 run --resume 从安全边界恢复未完成运行。",
    purposeEn:
      "Provide a beginner end-to-end path through create, run, chat, check, eval, doctor, and templates, with run --resume for unfinished runs that have a safe recovery boundary.",
    source: [
      "packages/coremind-cli/src",
      "packages/coremind-runtime/src/run-terminalizer.ts",
      "packages/coremind-runtime/src/snapshot.ts",
      "scripts/tty-acceptance.mjs",
    ],
    tests: [
      "packages/coremind-cli/src/cli.e2e.test.ts",
      "packages/coremind-cli/src/approval.test.ts",
      "packages/coremind-cli/src/commands/create.test.ts",
      "packages/coremind-cli/src/commands/run.test.ts",
      "packages/coremind-cli/src/tui.test.tsx",
      "packages/coremind-runtime/src/run-terminalizer.test.ts",
    ],
    dependencies: [
      "configure-coremind",
      "evaluate-agents",
      "enforce-agent-permissions",
      "manage-checkpoints",
    ],
    interfaces: [
      "coremind create",
      "coremind run --resume",
      "coremind chat",
      "coremind check",
      "coremind eval",
      "coremind doctor",
      "coremind templates",
      "coremind providers",
    ],
    errorsZh: [
      "命令失败返回非零退出码",
      "非 TTY 审批安全拒绝",
      "TUI 与 readline 使用同一 ChatSession Harness",
      "不安全或已结束的 runId 恢复会明确失败",
    ],
    errorsEn: [
      "Failed commands return a non-zero exit code",
      "Non-TTY approvals deny safely",
      "TUI and readline share the same ChatSession harness",
      "Unsafe or already-finished run IDs fail resume explicitly",
    ],
    stepsZh: [
      "用 create 生成或接入项目",
      "用 doctor 检查本地环境",
      "用 run 或 chat 开发",
      "用 check 与 eval 验收",
      "在脚本中使用 --print、--json-events 或 --json",
    ],
    stepsEn: [
      "Create or adopt a project",
      "Check the local environment with doctor",
      "Develop with run or chat",
      "Accept with check and eval",
      "Use --print, --json-events, or --json in automation",
    ],
    example:
      "coremind providers\ncoremind create my-agent --template translator --language typescript --provider alibaba-model-studio\ncoremind check my-agent/coremind.yaml\ncoremind eval my-agent/coremind.yaml",
  }),
  moduleOf({
    id: "embed-coremind-typescript",
    zh: "TypeScript SDK",
    en: "TypeScript SDK",
    purposeZh: "通过 coremind-ai 单一门面在 Node 工程中嵌入 Runtime、工具、会话、评测和事件。",
    purposeEn:
      "Embed runtime, tools, sessions, evaluation, and events in Node applications through the single coremind-ai facade.",
    source: [
      "packages/coremind/src/index.ts",
      "packages/coremind-runtime/src/public-tool.ts",
      "packages/coremind-runtime/src/snapshot.ts",
    ],
    tests: [
      "packages/coremind/src/index.test.ts",
      "packages/coremind-runtime/src/public-tool.test.ts",
      "packages/coremind-runtime/src/snapshot.test.ts",
    ],
    dependencies: ["configure-coremind", "design-agents", "build-tools"],
    interfaces: [
      "CoreMindRuntime",
      "ChatSession",
      "defineTool",
      "checkProject",
      "runEvaluationSuite",
    ],
    errorsZh: ["公共错误使用 CoreMindError.code", "库门面只 re-export，不复制业务逻辑"],
    errorsEn: [
      "Public failures use CoreMindError.code",
      "The facade only re-exports and never duplicates business logic",
    ],
    stepsZh: [
      "只从 coremind-ai 导入公共接口",
      "用 parseAndValidate 校验外部配置",
      "注入 defineTool 工具和审批处理器",
      "消费 RunOutcome 与结构化事件",
      "不要依赖 packages 内部路径",
    ],
    stepsEn: [
      "Import public APIs only from coremind-ai",
      "Validate external configuration with parseAndValidate",
      "Inject defineTool tools and an approval handler",
      "Consume RunOutcome and structured events",
      "Do not depend on package-internal paths",
    ],
    example:
      "const runtime = await CoreMindRuntime.create({\n  config,\n  configDir: process.cwd(),\n  initialPrompt: '执行任务',\n  toolDefinitions: [lookupOrder],\n});\nconst result = await runtime.run();",
  }),
  moduleOf({
    id: "embed-coremind-python",
    zh: "Python SDK 与工具桥",
    en: "Python SDK and Tool Bridge",
    purposeZh:
      "用 Python 客户端通过 stdio JSON-RPC 驱动同一 Node Runtime，并把 Python callable 注册为 Agent 工具。",
    purposeEn:
      "Drive the same Node runtime over stdio JSON-RPC from Python and register Python callables as agent tools.",
    source: [
      "python/src/coremind",
      "packages/coremind-worker/src",
      "packages/coremind-protocol/src",
      "scripts/build-python-worker.mjs",
    ],
    tests: [
      "python/tests/test_client.py",
      "python/tests/test_node_parity.py",
      "packages/coremind-worker/src/server.test.ts",
      "packages/coremind-protocol/src/protocol.test.ts",
      "python/tests/test_release_metadata.py",
    ],
    dependencies: ["configure-coremind", "build-tools", "inspect-agent-traces"],
    interfaces: [
      "CoreMindClient",
      "AsyncCoreMindClient",
      "@client.tool",
      "resume_run",
      "inspect_run",
      "checkpoint_diff",
      "checkpoint_restore",
      "CoreMind Protocol v1",
    ],
    errorsZh: [
      "协议错误映射为类型化 Python 异常",
      "worker 常驻复用，不为每次请求创建进程",
      "工具结果跨语言保持 JSON 可序列化",
      "resume_run 复用 Node Runtime 的同一安全恢复判定",
    ],
    errorsEn: [
      "Protocol errors map to typed Python exceptions",
      "The worker stays alive instead of spawning per request",
      "Tool results remain JSON-serializable across languages",
      "resume_run reuses the same safe-resume decision in the Node runtime",
    ],
    stepsZh: [
      "创建并复用一个客户端",
      "先 initialize，再注册 Python 工具",
      "为 callable 注解参数类型",
      "订阅事件和处理审批",
      "仅用 resume_run 恢复未完成且安全的运行",
      "在 finally 或上下文管理器中关闭 worker",
    ],
    stepsEn: [
      "Create and reuse one client",
      "Initialize before registering Python tools",
      "Annotate callable parameters",
      "Subscribe to events and handle approvals",
      "Use resume_run only for unfinished runs deemed safe",
      "Close the worker in a context manager or finally block",
    ],
    example:
      "with CoreMindClient(config_path='coremind.yaml') as client:\n    @client.tool(description='查询模拟订单')\n    def lookup_order(order_id: str) -> dict[str, str]:\n        return {'id': order_id, 'status': 'paid'}\n    result = client.run('查询 A-100')",
  }),
  moduleOf({
    id: "scaffold-coremind-projects",
    zh: "模板与项目文档",
    en: "Templates and Project Guidance",
    purposeZh:
      "根据新建或已有工程生成语言匹配的代码骨架、测试、评测、双语文档、SOP 和项目 Skill，且不覆盖原文件。",
    purposeEn:
      "Generate language-aware code skeletons, tests, evaluations, bilingual documentation, SOPs, and a project skill without overwriting existing files.",
    source: [
      "packages/coremind-templates/src/project-scaffold.ts",
      "packages/coremind-templates/templates",
    ],
    tests: [
      "packages/coremind-templates/src/project-scaffold.test.ts",
      "packages/coremind-templates/src/templates.test.ts",
      "packages/coremind-cli/src/cli.e2e.test.ts",
    ],
    dependencies: ["configure-coremind", "package-agent-skills", "evaluate-agents"],
    interfaces: ["detectProjectLanguage", "scaffoldProjectGuidance", "coremind create"],
    errorsZh: [
      "混合或空工程不猜语言",
      "使用 wx 写入，已有文件不会覆盖",
      "业务规则保留为需负责人确认的明确项",
    ],
    errorsEn: [
      "Mixed or empty projects do not guess a language",
      "wx writes preserve existing files",
      "Unknown business rules remain explicit owner-confirmation items",
    ],
    stepsZh: [
      "检查已有工程语言证据",
      "无法唯一判断时询问 TypeScript、JavaScript 或 Python",
      "选择最接近的模板",
      "生成后逐项确认业务 TODO",
      "运行 check 和 eval",
    ],
    stepsEn: [
      "Inspect language evidence in the existing project",
      "Ask for TypeScript, JavaScript, or Python when detection is ambiguous",
      "Choose the nearest template",
      "Confirm each business placeholder after generation",
      "Run check and eval",
    ],
    example:
      "coremind create . --template customer-triage\n# 混合或空工程：\ncoremind create . --template customer-triage --language python",
  }),
  moduleOf({
    id: "contribute-coremind",
    zh: "源码与社区贡献",
    en: "Source and Community Contribution",
    purposeZh:
      "在公开合同冻结、单向依赖、测试优先、双语材料和发布授权边界内修改 CoreMind 源码，并验证同提交发布物。",
    purposeEn:
      "Change CoreMind source within its frozen public contracts, one-way dependencies, test-first workflow, bilingual material contract, release authorization boundary, and same-commit artifact gates.",
    source: [
      "package.json",
      "vitest.config.ts",
      "vitest.engineering.config.ts",
      ".github/workflows/ci.yml",
      ".github/workflows/candidate-qualification.yml",
      ".github/workflows/docs.yml",
      ".github/workflows/release-please.yml",
      ".github/workflows/publish-pypi.yml",
      ".github/dependabot.yml",
      ".release-please-manifest.json",
      "release-please-config.json",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "docs/.vitepress/config.mts",
      "docs/providers/certifications.json",
      "docs/release/README.zh-CN.md",
      "docs/release/RC-ACCEPTANCE.zh-CN.md",
      "scripts/check-module-contract.mjs",
      "scripts/check-docs-site.mjs",
      "scripts/clean-package-dist.mjs",
      "scripts/generate-provider-matrix.mjs",
      "scripts/release-preflight.mjs",
      "scripts/release-version.mjs",
      "scripts/release-artifacts.mjs",
      "scripts/publish-npm-artifacts.mjs",
      "scripts/verify-pypi-artifact.mjs",
      "scripts/rc-acceptance.mjs",
      "scripts/tty-acceptance.mjs",
      "scripts/audit-markdown.mjs",
      "scripts/markdown-audit-lib.mjs",
      "scripts/package-artifacts.mjs",
      "scripts/validate-npm-tarballs.mjs",
      "scripts/validate-source-archive.mjs",
      "scripts/check-python-wheel.py",
      "scripts/test-stability.mjs",
      "scripts/check-coverage.mjs",
      "scripts/coverage-baseline.json",
      "scripts/phase2-baseline.mjs",
      "baselines/0.2.0-rc.1/baseline.json",
      "baselines/0.2.0-rc.1/behavior-matrix.json",
      "baselines/0.2.0-rc.1/coding-benchmark.json",
      "baselines/0.2.0-rc.1/platform-acceptance.json",
      "baselines/0.2.0-rc.1/release-gates.json",
      "baselines/0.2.0-rc.1/release-manifest.json",
    ],
    tests: [
      "scripts/check-module-contract.mjs",
      "scripts/docs-link-policy.test.ts",
      "scripts/provider-matrix.test.ts",
      "scripts/release-preflight.test.ts",
      "scripts/release-version.test.ts",
      "scripts/release-artifacts.test.ts",
      "scripts/publish-npm-artifacts.test.ts",
      "scripts/verify-pypi-artifact.test.ts",
      "scripts/rc-acceptance.test.ts",
      "scripts/markdown-audit.test.ts",
      "scripts/package-artifacts.test.ts",
      "scripts/source-archive.test.ts",
      "scripts/coverage-baseline.test.ts",
      "scripts/phase2-baseline.test.ts",
      "scripts/workflow-contract.test.ts",
      "python/tests/test_release_metadata.py",
      "packages/coremind/src/index.test.ts",
      "packages/coremind-cli/src/tui.test.tsx",
    ],
    dependencies: ["configure-coremind", "evaluate-agents", "scaffold-coremind-projects"],
    interfaces: [
      "npm run build",
      "npm test",
      "npm run check",
      "npm run check:modules",
      "npm run docs:build",
      "npm run docs:audit",
      "npm run test:stability",
      "npm run test:coverage",
      "npm run baseline:check",
      "npm run baseline:update -- --reason <reason>",
      "npm run providers:matrix",
      "npm run release:preflight",
      "npm run release:sync-version",
      "npm run acceptance:rc",
      "npm run release:bundle",
    ],
    errorsZh: [
      "依赖方向必须保持 config → tools → templates → runtime → facade/CLI/worker",
      "不得未经授权 push、tag 或发布",
      "不相关用户修改必须保留",
      "当前开发提交、采集时间、平台和构建哈希只是追溯证据；冻结 Release Tag 指向和 Release Manifest 摘要属于阻断合同",
      "冻结基线只允许在已批准的合同变更下用明确 reason 更新；不得追着测试结果降低门槛",
      "供应商可发现不等于已认证，正式发布必须有真实证据",
      "Release Please 只生成草稿 PR；Tag 与发布继续由维护者批准",
      "发布物必须来自同一干净 Tag，且通过哈希、来源证明与干净安装门禁",
    ],
    errorsEn: [
      "Dependencies must remain config to tools to templates to runtime to facade/CLI/worker",
      "Never push, tag, or publish without authorization",
      "Preserve unrelated user changes",
      "The current development commit, capture time, platform, and build hashes are trace evidence; the frozen Release Tag target and Release Manifest digest are blocking contracts",
      "Update the frozen baseline only for an approved contract change with an explicit reason; never lower gates to follow results",
      "Provider discovery is not certification; releases require live evidence",
      "Release Please creates a draft PR only; maintainers still approve tags and publication",
      "Artifacts must come from one clean tag and pass hash, attestation, and clean-install gates",
    ],
    stepsZh: [
      "先读 handoff 和权威方案",
      "先构建并运行冻结基线，确认改动前合同与行为基线成立",
      "写失败测试再做最小实现",
      "若改动有意改变公开合同，先记录迁移与回滚，再用明确原因更新基线",
      "同步模块合同与双语文档",
      "生成供应商矩阵并构建双语文档站",
      "执行全仓 Markdown、稳定性、覆盖率与 RC 验收",
      "按依赖顺序构建并验证同提交 npm、wheel 与源码 ZIP",
      "展示 diff，等待明确发布授权",
    ],
    stepsEn: [
      "Read the handoff and authoritative plan first",
      "Build and verify the frozen baseline before changing contracts or behavior",
      "Write a failing test before the smallest implementation",
      "For an intentional public-contract change, record migration and rollback before updating the baseline with an explicit reason",
      "Synchronize module contracts and bilingual docs",
      "Generate the provider matrix and build the bilingual documentation site",
      "Run repository-wide Markdown, stability, coverage, and RC acceptance",
      "Build in dependency order and verify same-commit npm, wheel, and source ZIP artifacts",
      "Show the diff and wait for explicit release authorization",
    ],
    skillVerification:
      "Run the tests listed in module.yaml, npm run baseline:check, npm run test:stability, npm run test:coverage, npm run docs:audit, npm run acceptance:rc, and npm run check:modules.",
    example:
      "npm run build\nnpm run baseline:check\nnpm run check\nnpm run test:stability\nnpm run test:coverage\nnpm run docs:audit\nnpm run acceptance:rc",
  }),
];

for (const item of modules) {
  const docsDir = path.join("docs", "modules", item.id);
  const examplesDir = path.join("examples", "modules", item.id);
  await mkdir(docsDir, { recursive: true });
  await mkdir(examplesDir, { recursive: true });
  await writeIfMissing("skills", item.id, "SKILL.md", skill(item));
  await writeIfMissing(docsDir, "README.zh-CN.md", readmeZh(item));
  await writeIfMissing(docsDir, "README.en.md", readmeEn(item));
  await writeIfMissing(docsDir, "SOP.zh-CN.md", sopZh(item));
  await writeIfMissing(docsDir, "SOP.en.md", sopEn(item));
  await writeIfMissing(docsDir, "GUIDE.zh-CN.md", guideZh(item));
  await writeIfMissing(docsDir, "GUIDE.en.md", guideEn(item));
  await writeIfMissing(docsDir, "CHANGELOG.md", changelog(item));
  await write(docsDir, "module.yaml", manifest(item));
  await writeIfMissing(examplesDir, "README.zh-CN.md", exampleZh(item));
  await writeIfMissing(examplesDir, "README.en.md", exampleEn(item));
}

await mkdir(path.join("docs", "modules"), { recursive: true });
await write("docs", "modules", "README.zh-CN.md", moduleIndex("zh"));
await write("docs", "modules", "README.en.md", moduleIndex("en"));

console.log(`已生成 ${modules.length} 个模块合同。`);

function moduleOf(value) {
  return {
    ...value,
    version,
    maturity: "release-candidate",
    platforms: value.platforms ?? ["windows", "linux"],
  };
}

async function write(...parts) {
  const content = parts.pop();
  const file = path.join(...parts);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content.replaceAll("\r\n", "\n"), "utf8");
}

async function writeIfMissing(...parts) {
  const content = parts.pop();
  const file = path.join(...parts);
  if (existsSync(file)) return;
  await write(...parts, content);
}

function links(item) {
  return [
    ...item.source.map((file) => `- [${file}](../../../${file.replaceAll("\\", "/")})`),
    ...item.tests.map((file) => `- [${file}](../../../${file.replaceAll("\\", "/")})`),
    `- [模块示例](../../../examples/modules/${item.id}/README.zh-CN.md)`,
    `- [Module example](../../../examples/modules/${item.id}/README.en.md)`,
    `- [Agent Skill](../../../skills/${item.id}/SKILL.md)`,
  ].join("\n");
}

function readmeZh(item) {
  return `# ${item.zh}\n\n状态：${item.maturity}；支持平台：Windows、Linux。macOS 尚未列为正式支持。\n\n## 目的\n\n${item.purposeZh}\n\n## 公共接口\n\n${item.interfaces.map((value) => `- \`${value}\``).join("\n")}\n\n## 错误与边界\n\n${item.errorsZh.map((value) => `- ${value}`).join("\n")}\n\nCoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。\n\n## 源码、测试与示例\n\n${links(item)}\n`;
}

function readmeEn(item) {
  return `# ${item.en}\n\nStatus: ${item.maturity}. Supported platforms: Windows and Linux. macOS is not yet officially supported.\n\n## Purpose\n\n${item.purposeEn}\n\n## Public interfaces\n\n${item.interfaces.map((value) => `- \`${value}\``).join("\n")}\n\n## Errors and boundaries\n\n${item.errorsEn.map((value) => `- ${value}`).join("\n")}\n\nCoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.\n\n## Source, tests, and examples\n\n${links(item)}\n`;
}

function sopZh(item) {
  return `# ${item.zh}开发 SOP\n\n## 前置条件\n\n先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。\n\n## 执行步骤\n\n${item.stepsZh.map((value, index) => `${index + 1}. ${value}。`).join("\n")}\n${item.stepsZh.length + 1}. 运行模块列出的测试，并执行 \`npm run check:modules\`。\n${item.stepsZh.length + 2}. 保存 Trace、评测和人工确认记录；未经明确授权不发布。\n\n## 停止条件\n\n遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。\n`;
}

function sopEn(item) {
  return `# ${item.en} Development SOP\n\n## Prerequisites\n\nRead the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.\n\n## Procedure\n\n${item.stepsEn.map((value, index) => `${index + 1}. ${value}.`).join("\n")}\n${item.stepsEn.length + 1}. Run the listed module tests and \`npm run check:modules\`.\n${item.stepsEn.length + 2}. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.\n\n## Stop conditions\n\nStop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.\n`;
}

function guideZh(item) {
  return `# ${item.zh}上手指南\n\n## 什么时候使用\n\n${item.purposeZh}\n\n## 最小示例\n\n\`\`\`text\n${item.example}\n\`\`\`\n\n## 验证\n\n1. 按 [SOP](SOP.zh-CN.md) 执行。\n2. 运行 [模块示例](../../../examples/modules/${item.id}/README.zh-CN.md)。\n3. 运行 \`coremind check\`；涉及业务输出时再运行 \`coremind eval\`。\n4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。\n\n## 常见误区\n\n- 不要让模型替业务负责人发明规则。\n- 不要把一次成功运行当成稳定性证明。\n- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。\n- 不要把继承 Provider 误称为已通过真实认证。\n`;
}

function guideEn(item) {
  return `# ${item.en} Guide\n\n## When to use it\n\n${item.purposeEn}\n\n## Minimal example\n\n\`\`\`text\n${item.example}\n\`\`\`\n\n## Verification\n\n1. Follow the [SOP](SOP.en.md).\n2. Run the [module example](../../../examples/modules/${item.id}/README.en.md).\n3. Run \`coremind check\`; also run \`coremind eval\` for business outputs.\n4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.\n\n## Common mistakes\n\n- Do not let the model invent business rules for the owner.\n- Do not treat one successful run as stability evidence.\n- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.\n- Do not describe inherited providers as genuinely certified.\n`;
}

function skill(item) {
  const description = `${item.purposeEn} Use when creating, changing, reviewing, or diagnosing the ${item.en.toLowerCase()} capability in a CoreMind project.`;
  const verification =
    item.skillVerification ??
    `Run the tests listed in [module.yaml](../../docs/modules/${item.id}/module.yaml) and \`npm run check:modules\`.`;
  return `---\nname: ${item.id}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${item.en}\n\n1. Read [the module contract](../../docs/modules/${item.id}/README.en.md) and the language-matched guide only when implementation details are needed.\n2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.\n3. Follow [the SOP](../../docs/modules/${item.id}/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.\n4. Add or update a failing test before implementation, then make the smallest change that passes it.\n5. Inspect RunOutcome, Trace, budgets, approvals, and checkpoints. Treat a fluent answer without evidence as unverified.\n6. ${verification}\n7. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.\n\n中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。\n`;
}

function exampleZh(item) {
  return `# ${item.zh}示例\n\n该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。\n\n\`\`\`text\n${item.example}\n\`\`\`\n\n## 验证步骤\n\n1. 从仓库根目录运行模块清单中的测试。\n2. 配置类示例运行 \`coremind check\`。\n3. 业务输出类示例补充场景后运行 \`coremind eval\`。\n4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。\n\n返回 [中文指南](../../../docs/modules/${item.id}/GUIDE.zh-CN.md)。\n`;
}

function exampleEn(item) {
  return `# ${item.en} Example\n\nThis is the smallest module example. Ask the business owner to confirm fields and rules before copying it.\n\n\`\`\`text\n${item.example}\n\`\`\`\n\n## Verification\n\n1. Run the tests listed in the module manifest from the repository root.\n2. Run \`coremind check\` for configuration examples.\n3. Add scenarios and run \`coremind eval\` for business outputs.\n4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.\n\nReturn to the [English guide](../../../docs/modules/${item.id}/GUIDE.en.md).\n`;
}

function changelog(item) {
  return `# Changelog\n\n## ${version} - 2026-08-08\n\n- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for ${item.en}.\n`;
}

function manifest(item) {
  const list = (values) => values.map((value) => `  - ${JSON.stringify(value)}`).join("\n");
  return `schemaVersion: 1\nid: ${item.id}\nname:\n  zh-CN: ${JSON.stringify(item.zh)}\n  en: ${JSON.stringify(item.en)}\nversion: ${version}\nsourcePaths:\n${list(item.source)}\ndocuments:\n  readme:\n    zh-CN: docs/modules/${item.id}/README.zh-CN.md\n    en: docs/modules/${item.id}/README.en.md\n  sop:\n    zh-CN: docs/modules/${item.id}/SOP.zh-CN.md\n    en: docs/modules/${item.id}/SOP.en.md\n  guide:\n    zh-CN: docs/modules/${item.id}/GUIDE.zh-CN.md\n    en: docs/modules/${item.id}/GUIDE.en.md\n  changelog: docs/modules/${item.id}/CHANGELOG.md\nskillPath: skills/${item.id}/SKILL.md\nexamplePaths:\n  - examples/modules/${item.id}/README.zh-CN.md\n  - examples/modules/${item.id}/README.en.md\ntestPaths:\n${list(item.tests)}\nsupportedPlatforms:\n${list(item.platforms)}\ndependencies:\n${item.dependencies.length > 0 ? list(item.dependencies) : "  []"}\nmaturity: ${item.maturity}\n`;
}

function moduleIndex(language) {
  const title = language === "zh" ? "# CoreMind 能力模块" : "# CoreMind Capability Modules";
  const intro =
    language === "zh"
      ? "每个模块均包含实现路径、测试、双语 README/SOP/指南、通用 Skill、示例和机器可检查清单。"
      : "Every module includes implementation paths, tests, bilingual README/SOP/guides, a reusable skill, examples, and a machine-checkable manifest.";
  const rows = modules
    .map((item) => {
      const label = language === "zh" ? item.zh : item.en;
      const file = language === "zh" ? "README.zh-CN.md" : "README.en.md";
      return `- [${label}](${item.id}/${file})`;
    })
    .join("\n");
  const completeIndex =
    language === "zh"
      ? "[查看完整 SOP/Skill 索引](SOP-SKILL-INDEX.zh-CN.md)"
      : "[Open the complete SOP/Skill index](SOP-SKILL-INDEX.en.md)";
  return `${title}\n\n${intro}\n\n${completeIndex}\n\n${rows}\n`;
}

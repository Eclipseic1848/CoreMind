import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const examples = [
  {
    id: "faq-order-assistant",
    titleZh: "FAQ/订单助手",
    titleEn: "FAQ and Order Assistant",
    profile: "order",
    port: 8811,
    language: "TypeScript",
    skill: "develop-faq-order-assistant",
    goalZh: "根据离线订单数据回答状态问题；订单不存在时明确失败，不得编造。",
    goalEn:
      "Answer status questions from offline order data and report missing orders without fabrication.",
    architectureZh: [
      "单 Agent",
      "TypeScript lookup_order 业务工具",
      "ask 权限审批",
      "正例与未找到反例",
    ],
    architectureEn: [
      "Single agent",
      "TypeScript lookup_order business tool",
      "ask-mode approval",
      "happy and not-found cases",
    ],
    run: 'node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "查询订单 A-100"',
    eval: "node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml",
    expectedZh: "输出“订单 A-100 已支付，金额 299 元”，并记录一次 lookup_order 审批与工具调用。",
    expectedEn:
      "Outputs that A-100 is paid for 299 and records one lookup_order approval and tool call.",
    failuresZh: [
      "未启动 mock Provider：先运行启动命令并检查 8811 端口",
      "非 TTY 下 ask 默认拒绝：交互执行，或在可信离线 CI 中显式使用 --permission full",
      "A-999 返回未找到是预期业务失败分支，不应改成虚构订单",
    ],
    failuresEn: [
      "Mock provider is not running: start it and check port 8811",
      "ask denies safely in non-TTY mode: run interactively or explicitly use --permission full in trusted offline CI",
      "A-999 returning not found is the expected business failure branch; do not fabricate an order",
    ],
  },
  {
    id: "contract-review-workflow",
    titleZh: "合同审核 Agent",
    titleEn: "Contract Review Agent",
    profile: "contract",
    port: 8812,
    language: "TypeScript",
    skill: "review-contracts-safely",
    goalZh: "按条款提取、风险审核、结构化输出三步生成必须人工复核的合同风险报告。",
    goalEn:
      "Produce a human-reviewable contract risk report through extraction, risk review, and structured output.",
    architectureZh: [
      "三个职责隔离的 Agent",
      "固定三步 Workflow",
      "JSON 输出宿主二次校验",
      "无网络和写副作用",
    ],
    architectureEn: [
      "Three responsibility-isolated agents",
      "Fixed three-step workflow",
      "Host-side JSON validation",
      "No network or write side effects",
    ],
    run: 'node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "服务费用30天支付，未约定责任上限"',
    eval: "node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml",
    expectedZh: "最终 JSON 的 riskLevel 为 high，requiresHumanReview 为 true。",
    expectedEn: "The final JSON has riskLevel high and requiresHumanReview true.",
    failuresZh: [
      "输出不是 JSON：宿主 parseContractReview 必须拒绝，不能用字符串猜测",
      "步骤缺失：检查 maxSteps 是否至少为 3",
      "合同判断只用于示例，不能替代律师和业务负责人",
    ],
    failuresEn: [
      "Output is not JSON: parseContractReview must reject instead of guessing",
      "A step is missing: ensure maxSteps is at least 3",
      "The example does not replace legal counsel or the business owner",
    ],
  },
  {
    id: "python-data-analysis",
    titleZh: "数据分析 Agent",
    titleEn: "Data Analysis Agent",
    profile: "data",
    port: 8813,
    language: "Python",
    skill: "analyze-sales-with-python",
    goalZh: "通过 Python SDK 注册 callable 工具，确定性汇总 CSV，并把文件结果写入工作区。",
    goalEn:
      "Register a callable through the Python SDK, summarize CSV data deterministically, and write the artifact inside the workspace.",
    architectureZh: [
      "Python CoreMindClient",
      "常驻 Node worker",
      "Python analyze_sales callable",
      "JSON 文件产物",
    ],
    architectureEn: [
      "Python CoreMindClient",
      "Persistent Node worker",
      "Python analyze_sales callable",
      "JSON file artifact",
    ],
    run: "python src/main.py",
    eval: 'python -m unittest discover -s tests -p "test_*.py"',
    expectedZh: "返回 rows=3、total=300，并在 artifacts/summary.json 写入华东与华南汇总。",
    expectedEn:
      "Returns rows=3 and total=300, then writes East and South region totals to artifacts/summary.json.",
    failuresZh: [
      "找不到 worker：先在仓库根目录运行 npm run build:python-worker",
      "找不到 coremind：安装 wheel 或设置 PYTHONPATH=../../../python/src",
      "路径穿越会被 Python 工具拒绝，这是安全预期",
    ],
    failuresEn: [
      "Worker not found: run npm run build:python-worker at the repository root",
      "coremind import fails: install the wheel or set PYTHONPATH=../../../python/src",
      "Path traversal is rejected by the Python tool by design",
    ],
  },
  {
    id: "bounded-research-agent",
    titleZh: "研究/问题调查 Agent",
    titleEn: "Bounded Research Agent",
    profile: "research",
    port: 8814,
    language: "TypeScript",
    skill: "investigate-with-bounded-research",
    goalZh:
      "在明确工具、重试、turn、step、token 和超时预算内收集离线证据，并由独立 Reviewer 审查。",
    goalEn:
      "Collect offline evidence within explicit tool, retry, turn, step, token, and timeout budgets, then use an isolated reviewer.",
    architectureZh: [
      "Researcher + Reviewer",
      "可验证 retry 条件",
      "高风险自定义工具人工批准",
      "Trace、Context 保护和预算",
    ],
    architectureEn: [
      "Researcher plus reviewer",
      "Verifiable retry condition",
      "Human approval for a custom tool",
      "Trace, context protection, and budgets",
    ],
    run: 'node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "是否应直接用于高影响决策"',
    eval: "node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml",
    expectedZh: "结论建议小规模试点，引用 S1/S2，保留人工复核和中等置信度。",
    expectedEn:
      "Recommends a small pilot, cites S1/S2, preserves human review, and reports medium confidence.",
    failuresZh: [
      "审批被拒绝：这是安全结果；确认工具参数后重试",
      "出现 INCOMPLETE：最多只重试一次，耗尽后必须失败或保留不足",
      "不得把离线证据扩写为真实互联网来源",
    ],
    failuresEn: [
      "Approval denied: this is a safe result; inspect arguments before retrying",
      "INCOMPLETE retries only once; exhaustion must fail or retain the limitation",
      "Never expand offline evidence into fabricated internet sources",
    ],
  },
  {
    id: "verified-repair-loop",
    titleZh: "验证修复 Loop",
    titleEn: "Verified Repair Loop",
    profile: "loop",
    port: 8815,
    language: "TypeScript",
    implementationPaths: ["coremind.yaml"],
    skill: "build-verified-repair-loop",
    goalZh: "先生成候选结果，再由独立验证者判定；失败时有界修复，并演示暂停恢复与耗尽终态。",
    goalEn:
      "Generate a candidate, verify it independently, repair within bounds, and demonstrate pause-resume and exhaustion outcomes.",
    architectureZh: [
      "Executor + Verifier + Repairer",
      "显式有界 Loop",
      "稳定快照暂停恢复",
      "失败注入与耗尽断言",
    ],
    architectureEn: [
      "Executor, verifier, and repairer",
      "Explicit bounded Loop",
      "Pause-resume from stable snapshots",
      "Failure injection and exhaustion assertions",
    ],
    run: 'node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "修复候选结果"',
    eval: "node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml",
    expectedZh:
      "首次验证返回 FAIL，修复后再次验证返回 PASS，最终输出 candidate-fixed；测试同时验证暂停恢复与耗尽失败。",
    expectedEn:
      "The first verification returns FAIL, repair produces candidate-fixed, and the next verification returns PASS; tests also cover pause-resume and exhaustion.",
    failuresZh: [
      "验证失败不是运行成功：必须进入 repair、pause 或 fail",
      "暂停后使用同一 runId 恢复，不得重复已经完成的 execute",
      "maxRepairs 耗尽必须返回 loop_exhausted，不能接受未通过结果",
    ],
    failuresEn: [
      "A failed verification is not success: it must transition to repair, pause, or fail",
      "Resume the same runId after pause without replaying a completed execute step",
      "Exhausting maxRepairs must return loop_exhausted instead of accepting an unverified result",
    ],
  },
];

for (const item of examples) {
  const root = path.join("examples", "golden", item.id);
  await write(root, "README.zh-CN.md", readme(item, "zh"));
  await write(root, "README.en.md", readme(item, "en"));
  await write(root, "SOP.zh-CN.md", sop(item, "zh"));
  await write(root, "SOP.en.md", sop(item, "en"));
  await write(root, "FAILURES.zh-CN.md", failures(item, "zh"));
  await write(root, "FAILURES.en.md", failures(item, "en"));
  await write(root, "docs", "requirements.zh-CN.md", requirements(item, "zh"));
  await write(root, "docs", "requirements.en.md", requirements(item, "en"));
  await write(root, "docs", "architecture.zh-CN.md", architecture(item, "zh"));
  await write(root, "docs", "architecture.en.md", architecture(item, "en"));
  await write(root, "docs", "development-sop.zh-CN.md", sop(item, "zh"));
  await write(root, "docs", "development-sop.en.md", sop(item, "en"));
  await write(root, "docs", "testing-guide.zh-CN.md", testing(item, "zh"));
  await write(root, "docs", "testing-guide.en.md", testing(item, "en"));
  await write(root, "docs", "acceptance-checklist.zh-CN.md", acceptance("zh"));
  await write(root, "docs", "acceptance-checklist.en.md", acceptance("en"));
  await write(root, "tests", "README.md", testReadme(item));
  await write(root, ".coremind", "decisions.md", decisions(item));
  await write(root, ".coremind", "checkpoints", ".gitkeep", "");
  await write(root, "example.yaml", manifest(item));
  await write(root, "skills", "project-agent", "SKILL.md", projectSkill(item));
  await write(root, "skills", item.skill, "SKILL.md", exampleSkill(item));
}

await write("examples", "golden", "README.zh-CN.md", index("zh"));
await write("examples", "golden", "README.en.md", index("en"));
console.log(`已生成 ${examples.length} 个黄金示例的双语开发材料。`);

async function write(...parts) {
  const content = parts.pop();
  const file = path.join(...parts);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content.replaceAll("\r\n", "\n"), "utf8");
}

function readme(item, language) {
  const zh = language === "zh";
  return `# ${zh ? item.titleZh : item.titleEn}\n\n${zh ? item.goalZh : item.goalEn}\n\n## ${zh ? "离线运行" : "Offline run"}\n\n1. ${zh ? "在仓库根目录构建" : "Build at the repository root"}：\`npm run build:python-worker\`。\n2. ${zh ? "进入本目录并设置仅用于本地 mock 的环境变量" : "Enter this directory and set the local-mock environment variable"}：PowerShell \`$env:GOLDEN_MOCK_API_KEY="offline"\`；Linux \`export GOLDEN_MOCK_API_KEY=offline\`。\n3. ${zh ? "启动 Provider" : "Start the provider"}：\`node ../_shared/mock-provider.mjs ${item.profile} ${item.port}\`。\n4. ${zh ? "另开终端执行" : "Run in another terminal"}：\`${item.run}\`。\n5. ${zh ? "执行评测" : "Run evaluation"}：\`${item.eval}\`。\n\n## ${zh ? "期望证据" : "Expected evidence"}\n\n${zh ? item.expectedZh : item.expectedEn}\n\n- ${zh ? "配置" : "Configuration"}：[coremind.yaml](coremind.yaml)\n- ${zh ? "场景" : "Scenarios"}：[evals/scenarios.yaml](evals/scenarios.yaml)\n- SOP：[${zh ? "中文" : "English"}](SOP.${zh ? "zh-CN" : "en"}.md)\n- ${zh ? "失败与修复" : "Failures and repairs"}：[${zh ? "中文" : "English"}](FAILURES.${zh ? "zh-CN" : "en"}.md)\n\n${zh ? "本示例只使用模拟数据；真实 Provider 配置必须改用 apiKeyEnv，并在获得数据外传授权后再启用。" : "This example uses mock data only. A real provider must use apiKeyEnv and requires authorization before data egress."}\n`;
}

function sop(item, language) {
  const zh = language === "zh";
  const steps = zh
    ? [
        "阅读 requirements 与 architecture",
        "启动离线 Provider，确认未使用真实密钥",
        "先运行 coremind check",
        "执行正常场景并保存 RunOutcome/Trace",
        "执行失败场景并确认没有伪成功",
        "运行自动测试与评测",
        "由业务负责人确认后再迁移真实数据或 Provider",
      ]
    : [
        "Read requirements and architecture",
        "Start the offline provider and confirm no real secret is used",
        "Run coremind check first",
        "Run the happy path and preserve RunOutcome/Trace",
        "Run the failure path and confirm it never masquerades as success",
        "Run automated tests and evaluation",
        "Require owner approval before using real data or a real provider",
      ];
  return `# ${item.titleEn} SOP / ${item.titleZh}\n\n${steps.map((step, index) => `${index + 1}. ${step}.`).join("\n")}\n\n${zh ? "停止条件：业务规则未确认、需要工作区外访问、出现不可逆副作用、真实密钥缺失或安全门禁失败。" : "Stop for unconfirmed rules, access outside the workspace, non-reversible side effects, missing real credentials, or a failed security gate."}\n`;
}

function failures(item, language) {
  const zh = language === "zh";
  const items = zh ? item.failuresZh : item.failuresEn;
  return `# ${zh ? "失败案例与修复" : "Failure Cases and Repairs"}\n\n${items.map((value, index) => `${index + 1}. ${value}.`).join("\n")}\n\n${zh ? "修复后重新运行对应失败场景，并比较修复前后 Trace；不要只看最终回答。" : "After repair, rerun the same failing scenario and compare before-and-after traces rather than only final text."}\n`;
}

function requirements(item, language) {
  const zh = language === "zh";
  return `# ${zh ? "需求" : "Requirements"}\n\n## ${zh ? "目标" : "Goal"}\n\n${zh ? item.goalZh : item.goalEn}\n\n## ${zh ? "输入与输出" : "Input and output"}\n\n${zh ? item.expectedZh : item.expectedEn}\n\n## ${zh ? "非目标" : "Non-goals"}\n\n- ${zh ? "不连接生产数据或生产接口" : "No production data or production endpoints"}\n- ${zh ? "不替代业务、法律或安全负责人" : "Does not replace business, legal, or security owners"}\n- ${zh ? "不把 mock Provider 的结果当作真实模型认证" : "Does not treat mock-provider results as real model certification"}\n`;
}

function architecture(item, language) {
  const zh = language === "zh";
  const values = zh ? item.architectureZh : item.architectureEn;
  return `# ${zh ? "架构" : "Architecture"}\n\n- ${zh ? "实现语言" : "Implementation language"}：${item.language}\n${values.map((value) => `- ${value}`).join("\n")}\n- ${zh ? "统一执行核心" : "Unified execution core"}：Node CoreMindRuntime\n- ${zh ? "数据出口" : "Data egress"}：${zh ? "默认关闭，仅访问本地 mock" : "disabled by default; local mock only"}\n`;
}

function testing(item, language) {
  const zh = language === "zh";
  return `# ${zh ? "测试指南" : "Testing Guide"}\n\n1. \`coremind check coremind.yaml\`。\n2. ${zh ? "运行离线正常场景" : "Run the offline happy path"}。\n3. ${zh ? "运行 FAILURES 中的至少一个失败场景" : "Run at least one failure from FAILURES"}。\n4. \`${item.eval}\`。\n5. ${zh ? "确认退出码、RunOutcome、工具计数、审批、Trace 与 checkpoint 符合预期" : "Verify exit code, RunOutcome, tool counts, approvals, trace, and checkpoints"}。\n`;
}

function acceptance(language) {
  const zh = language === "zh";
  const values = zh
    ? [
        "配置和项目材料检查通过",
        "离线正常与失败场景均有证据",
        "失败没有伪装成成功",
        "权限、预算、Trace 和 checkpoint 可见",
        "评测达到 100% 门槛",
        "业务负责人确认示例规则",
      ]
    : [
        "Configuration and project materials pass checks",
        "Offline happy and failure cases have evidence",
        "Failures never masquerade as success",
        "Permissions, budgets, traces, and checkpoints are visible",
        "Evaluation reaches the 100% threshold",
        "The business owner confirms example rules",
      ];
  return `# ${zh ? "验收清单" : "Acceptance Checklist"}\n\n${values.map((value) => `- [ ] ${value}`).join("\n")}\n`;
}

function testReadme(item) {
  return `# ${item.titleZh} Tests / ${item.titleEn} Tests\n\n- Node 示例由 \`examples/golden/golden-examples.test.ts\` 执行真实 Runtime 与场景评测。\n- Python 示例由本目录 test_example.py 执行 callable 与 Node worker 集成测试。\n- RunOutcome、Trace、工具审批和评测通过率都是断言对象。\n`;
}

function decisions(item) {
  return `# 决策记录 / Decision Log\n\n- 2026-08-08：选择 ${item.language}，仅使用本地 mock Provider 与模拟数据。\n- 权限默认 ask；测试中的自动批准仅限已知示例工具，并保留 Trace。\n- 真实数据字段、生产接口和审批责任不在示例范围内。\n`;
}

function projectSkill(item) {
  return `---\nname: project-agent\ndescription: ${JSON.stringify(`Develop and verify the ${item.titleEn} CoreMind golden example. Use when adapting this example, its business rules, tools, workflow, evaluation, or failure cases.`)}\n---\n\n# ${item.titleEn}\n\n1. Read ../../docs/requirements.en.md and ../../docs/architecture.en.md.\n2. Keep the example offline until the owner explicitly approves real data egress.\n3. Change one confirmed business rule at a time and add its scenario first.\n4. Run CoreMind check, the automated test, and evaluation.\n5. Inspect RunOutcome, approvals, budgets, Trace, and checkpoints; do not accept fluent text alone.\n6. Stop before any unconfirmed production integration, irreversible action, push, tag, or publish.\n`;
}

function exampleSkill(item) {
  return `---\nname: ${item.skill}\ndescription: ${JSON.stringify(`Run, diagnose, and safely adapt the offline ${item.titleEn} golden example. Use for this example's configuration, implementation, evaluation, or documented failure cases.`)}\n---\n\n# ${item.titleEn}\n\n1. Read ../../README.en.md and ../../SOP.en.md.\n2. Start the local ${item.profile} mock provider on port ${item.port}; never substitute a real endpoint silently.\n3. Execute the documented happy path and one failure case.\n4. Preserve approval and Trace evidence, then run the example evaluation.\n5. Ask the business owner before changing data fields, decisions, thresholds, or external access.\n`;
}

function manifest(item) {
  const test =
    item.id === "python-data-analysis" ? "tests/test_example.py" : "../golden-examples.test.ts";
  const implementationPaths = item.implementationPaths ?? ["src"];
  return `schemaVersion: 1\nid: ${item.id}\nlanguage: ${item.language.toLowerCase()}\noffline: true\nconfigPath: coremind.yaml\nscenarioPath: evals/scenarios.yaml\nimplementationPaths:\n${implementationPaths.map((value) => `  - ${value}`).join("\n")}\ntestPath: ${test}\ndocuments:\n  zh-CN: README.zh-CN.md\n  en: README.en.md\n  sopZh: SOP.zh-CN.md\n  sopEn: SOP.en.md\n  failuresZh: FAILURES.zh-CN.md\n  failuresEn: FAILURES.en.md\nskillPath: skills/${item.skill}/SKILL.md\nqualityProfile: standard\nminimumPassRate: 1\n`;
}

function index(language) {
  const zh = language === "zh";
  return `# ${zh ? "CoreMind 黄金示例" : "CoreMind Golden Examples"}\n\n${zh ? "全部示例均使用模拟数据和本地 Provider，可离线执行；继承 Provider 不等于真实认证。" : "All examples use mock data and a local provider, so they run offline. Inherited provider support is not real certification."}\n\n${examples.map((item) => `- [${zh ? item.titleZh : item.titleEn}](${item.id}/README.${zh ? "zh-CN" : "en"}.md)`).join("\n")}\n`;
}

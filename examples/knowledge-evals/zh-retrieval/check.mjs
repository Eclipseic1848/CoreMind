import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const { asOf, documents } = JSON.parse(read("./manifest.json"));
const cases = read("./cases.jsonl")
  .trimEnd()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
const sources = new Map(
  documents.map((doc) => [
    doc.file,
    { ...doc, lines: read(`./sources/${doc.file}`).split(/\r?\n/) },
  ]),
);

assert.equal(sources.size, documents.length, "来源文件名重复");
assert.equal(new Set(cases.map((item) => item.id)).size, cases.length, "题号重复");
assert.equal(new Set(cases.map((item) => item.question)).size, cases.length, "问题重复");

function locate({ file, line, quote }, id) {
  const source = sources.get(file);
  assert.ok(source && Number.isInteger(line) && line > 0 && quote, `${id}：来源定位无效`);
  assert.ok(source.lines[line - 1]?.includes(quote), `${id}：对应行找不到标注摘录`);
  return source;
}

const isCurrent = (doc) => doc.validFrom <= asOf && (!doc.validUntil || asOf < doc.validUntil);
const isVisible = (doc, scope) => doc.access === "public" || doc.access === scope;

for (const item of cases) {
  const { answer, evidence, decoy, scope, kind, id } = item;
  assert.ok(["public", "desk"].includes(scope), `${id}：未知身份`);
  if (answer !== null) {
    const doc = locate(evidence, id);
    assert.ok(isCurrent(doc) && isVisible(doc, scope), `${id}：正例不可采信`);
    assert.ok(answer && evidence.quote.includes(answer), `${id}：标注答案不在引文内`);
  } else {
    assert.equal(evidence, null, `${id}：拒答题不应引用`);
    if (kind === "missing") {
      assert.equal(decoy, undefined, `${id}：缺失类不应指定干扰项`);
    } else {
      const doc = locate(decoy, id);
      assert.ok(
        (kind === "expired" && !isCurrent(doc) && isVisible(doc, scope)) ||
          (kind === "restricted" && isCurrent(doc) && !isVisible(doc, scope)),
        `${id}：干扰项必须符合题目标注的版本或权限条件`,
      );
    }
  }
}

const positive = cases.filter((item) => item.answer !== null);
assert.equal(positive.length, 30);
assert.equal(cases.length - positive.length, 10);
assert.equal(new Set(positive.map(({ evidence }) => `${evidence.file}:${evidence.line}`)).size, 30);

const { rounds } = JSON.parse(read("./organize-materials.json"));
assert.equal(rounds.length, 3);
assert.equal(new Set(rounds.map(({ session }) => session)).size, 3, "应使用独立会话");
for (const round of rounds) {
  for (const ref of round.expected.evidence) {
    const doc = locate(ref, round.session);
    assert.ok(round.sources.includes(ref.file) && isCurrent(doc) && isVisible(doc, "public"));
  }
}

const [first, second, third] = rounds;
const [oldFile, newFile] = first.sources;
for (const ref of first.expected.historicalRows) {
  assert.equal(ref.file, oldFile);
  assert.equal(locate(ref, first.session).version, 1);
}
assert.equal(sources.get(newFile).version, 2);
assert.equal(sources.get(oldFile).id, sources.get(newFile).id);
const rowCodes = (file) =>
  sources.get(file).lines.flatMap((line) => line.match(/^\| (ST-\d+) \|/)?.[1] ?? []);
const citedCodes = (refs) => refs.map(({ quote }) => quote.split(" | ")[0]);
const oldCodes = rowCodes(oldFile);
assert.deepEqual(citedCodes(first.expected.historicalRows), oldCodes);
assert.deepEqual(
  citedCodes(first.expected.evidence),
  rowCodes(newFile).filter((id) => !oldCodes.includes(id)),
);
assert.equal(first.after[0].remember.value, second.expected.format);
assert.equal(second.after[0].replace.previous, second.expected.format);
assert.equal(second.after[0].replace.value, third.expected.format);
const { withdraw } = second.after[1];
assert.ok(second.expected.evidence.some((ref) => ref.file === withdraw));
assert.ok(!third.sources.includes(withdraw));
console.log(`已核对 ${sources.size} 份合成资料、30 道有答案题、10 道无答案题和三轮整理场景。`);

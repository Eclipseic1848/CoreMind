import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from answer_benchmark import evaluate
from keyword_baseline import ROOT


class AnswerReplayTest(unittest.TestCase):
    def test_holdout_separates_retrieval_answer_citation_and_refusal(self):
        report = evaluate(None, None, None, replay_file=ROOT / "holdout-replay.json")
        self.assertTrue(report["passed"])
        self.assertEqual(report["provider"], "replay")
        self.assertEqual(report["retrievalTop1Hits"], 6)
        self.assertEqual(report["retrievalTop5Hits"], 7)
        self.assertEqual(report["answerTextMatches"], 7)
        self.assertEqual(report["goldCitationMatches"], 7)
        self.assertEqual(report["correctRefusals"], 6)
        self.assertEqual(report["unanswerableWithCandidates"], 4)

        fixed = [json.loads(line) for line in (ROOT / "cases.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertFalse({row["question"] for row in fixed} & {row["question"] for row in report["cases"]})
        self.assertEqual(next(row["retrievalRank"] for row in report["cases"] if row["id"] == "H07"), 2)
        for row in report["cases"]:
            for excerpt in row["inputExcerpts"]:
                if row["kind"] in {"restricted", "expired"}:
                    self.assertNotEqual(excerpt["file"], "值班附页-v1.md")
                    self.assertNotEqual(excerpt["file"], "资料室手册-v1.md")

    def test_wrong_citation_and_unsupported_answer_fail_replay_gate(self):
        fixture = json.loads((ROOT / "holdout-replay.json").read_text(encoding="utf-8"))
        fixture["H07"] = {"answer": "未拆封", "citations": [["值班附页-v1.md", 1]], "support": False}
        fixture["HN05"] = {"answer": "由寄件人承担", "citations": [["流转索引-v2.md", 15]], "support": True}
        fixture["HN06"] = {"answer": "需要先消磁", "citations": [["流转索引-v2.md", 12]], "support": False}
        with tempfile.TemporaryDirectory() as directory:
            replay = Path(directory) / "replay.json"
            output = Path(directory) / "report.json"
            replay.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-B", "-X", "utf8", str(ROOT / "answer_benchmark.py"),
                 "--replay", str(replay), "--output", str(output)],
                capture_output=True, encoding="utf-8", timeout=30,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            report = json.loads(output.read_text(encoding="utf-8"))

        self.assertFalse(report["passed"])
        self.assertEqual(report["retrievalTop5Hits"], 7)
        self.assertEqual(report["answerTextMatches"], 7)
        self.assertEqual(report["goldCitationMatches"], 6)
        self.assertEqual(report["correctAnswerWithCitation"], 6)
        self.assertEqual(report["correctRefusals"], 4)
        self.assertEqual(report["withheldAssertions"], 1)
        self.assertEqual(report["unsupportedAnswerIds"], ["HN05"])
        self.assertEqual(report["verifierRejectedIds"], ["H07", "HN06"])


if __name__ == "__main__":
    unittest.main()

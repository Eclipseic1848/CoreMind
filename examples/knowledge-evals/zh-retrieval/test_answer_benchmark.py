import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from answer_benchmark import chat, evaluate
from keyword_baseline import ROOT


class AnswerReplayTest(unittest.TestCase):
    def test_bounded_flash_json_preserves_budget_and_records_response_model(self):
        flash = "deepseek-v4.1-flash-1017"
        for model, returned in [(flash, flash), ("other-model", "other-model"), (flash, "wrong-model")]:
            with self.subTest(model=model, returned=returned), patch.dict(os.environ, DASHSCOPE_API_KEY="fixture"):
                opener = Mock()
                body = {"model": returned, "choices": [
                    {"message": {"content": '{"support":false}'}, "finish_reason": "stop"}
                ]}
                opener.open.return_value = io.BytesIO(json.dumps(body).encode("utf-8"))
                if returned != model:
                    with self.assertRaisesRegex(ValueError, "快照不一致"):
                        chat(opener, "dashscope", model, "核验", {}, "合成输入", 32)
                else:
                    usage, _, answer, complete = chat(opener, "dashscope", model, "核验", {}, "合成输入", 32)
                    self.assertTrue(complete)
                    self.assertEqual(answer, {"support": False})
                    self.assertEqual(usage["providerCall"], {"model": model, "finishReason": "stop"})
                request = json.loads(opener.open.call_args.args[0].data)
                self.assertEqual(request["max_tokens"], 32)
                if model == flash:
                    self.assertIs(request["enable_thinking"], False)
                else:
                    self.assertNotIn("enable_thinking", request)

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
        self.assertEqual(report["taskPasses"], 10)
        self.assertEqual(report["guardedPasses"], 11)
        blocked = next(row for row in report["cases"] if row["id"] == "HN06")
        self.assertTrue(blocked["passed"])
        self.assertFalse(blocked["taskPassed"])
        self.assertEqual(report["withheldAssertions"], 1)
        self.assertEqual(report["unsupportedAnswerIds"], ["HN05"])
        self.assertEqual(report["verifierRejectedIds"], ["H07", "HN06"])


if __name__ == "__main__":
    unittest.main()

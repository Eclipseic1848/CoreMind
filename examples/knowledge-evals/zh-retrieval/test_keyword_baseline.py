import json
import unittest

from keyword_baseline import ROOT, check_candidates


class CandidateScopeTest(unittest.TestCase):
    def test_rejects_expired_and_restricted_search_results(self):
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        sources = {doc["file"]: doc for doc in manifest["documents"]}
        cases = (ROOT / "cases.jsonl").read_text(encoding="utf-8").splitlines()
        tested = set()
        for case in map(json.loads, cases):
            if decoy := case.get("decoy"):
                with self.subTest(question=case["id"]), self.assertRaises(ValueError):
                    check_candidates(
                        [(decoy["file"], decoy["line"])], case["scope"], manifest["asOf"], sources
                    )
                tested.add(case["kind"])
        self.assertEqual(tested, {"expired", "restricted"})


if __name__ == "__main__":
    unittest.main()

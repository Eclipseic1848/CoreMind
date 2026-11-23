"""核对三个真实文档的中文内容、表格关联和引用位置。"""

import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parent


class DoclingBridgeTest(unittest.TestCase):
    def parse(self, name):
        result = subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(ROOT / "docling_bridge.py"), str(ROOT / "formats" / name)],
            capture_output=True, encoding="utf-8",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_pdf_text_and_scan(self):
        chunks = self.parse("值班记录.pdf")
        self.assertIn({"text": "纸质目录统一使用蓝色封面。", "locator": "page:1"}, chunks)
        self.assertIn({"text": "夜班交接使用绿色封条。", "locator": "page:2"}, chunks)

    def test_docx_table(self):
        table = next(
            row["text"] for row in self.parse("归档窗口.docx")
            if row["locator"] == "section:归档窗口" and "银杏台" in row["text"]
        )
        rows = [[cell.strip() for cell in row.strip("|").split("|")] for row in table.splitlines()]
        self.assertIn(["物件", "窗口"], rows)
        self.assertIn(["松纹卡", "银杏台"], rows)

    def test_markdown_heading(self):
        self.assertIn(
            {"text": "石青标签用于标记已复核的纸质目录。", "locator": "section:校验约定"},
            self.parse("校验约定.md"),
        )


if __name__ == "__main__":
    unittest.main()

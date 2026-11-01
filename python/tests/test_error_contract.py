from __future__ import annotations

import unittest

from coremind import ERROR_CODES, ProtocolError, error_code_info


class ErrorContractTest(unittest.TestCase):
    def test_task_commit_errors_do_not_enable_automatic_retry(self) -> None:
        for code in ("task_commit_invalid", "task_commit_conflict", "task_store_corrupt", "task_store_unavailable"):
            with self.subTest(code=code):
                error = ProtocolError("任务状态需要核对", rpc_code=-32000, coremind_code=code)
                self.assertEqual(error.error_info, ERROR_CODES[code])
                self.assertEqual(error.error_info["retryClass"], "fatal")
                self.assertEqual(error.error_info["runStatus"], "failed")

    def test_model_output_limit_is_terminal_without_retry(self) -> None:
        self.assertEqual(
            error_code_info("model_output_limit"),
            {
                "terminality": "terminal",
                "cancelClass": "other",
                "retryClass": "fatal",
                "humanAction": "none",
                "runStatus": "failed",
            },
        )
    def test_registered_code_exposes_shared_classification(self) -> None:
        self.assertEqual(
            error_code_info("cursor_expired"),
            {
                "terminality": "terminal",
                "cancelClass": "other",
                "retryClass": "fatal",
                "humanAction": "none",
                "runStatus": "failed",
            },
        )
        self.assertEqual(ERROR_CODES["unclassified_error"]["humanAction"], "required")

    def test_protocol_error_carries_registered_classification(self) -> None:
        error = ProtocolError(
            "需要人工审计",
            rpc_code=-32000,
            coremind_code="unclassified_error",
        )

        self.assertEqual(error.error_info, error_code_info("unclassified_error"))
        self.assertEqual(error.error_info["retryClass"], "human")


if __name__ == "__main__":
    unittest.main()

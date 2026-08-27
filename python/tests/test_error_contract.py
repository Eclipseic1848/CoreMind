from __future__ import annotations

import unittest

from coremind import ERROR_CODES, ProtocolError, error_code_info


class ErrorContractTest(unittest.TestCase):
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

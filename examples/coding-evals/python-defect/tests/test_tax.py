import unittest

from src.pricing import calculate_total


class CalculateTotalTest(unittest.TestCase):
    def test_adds_tax_to_subtotal(self) -> None:
        self.assertEqual(calculate_total(100.0, 0.2), 120.0)


if __name__ == "__main__":
    unittest.main()

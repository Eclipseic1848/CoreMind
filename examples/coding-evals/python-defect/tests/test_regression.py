import unittest

from src.pricing import calculate_total


class CalculateTotalRegressionTest(unittest.TestCase):
    def test_zero_tax_keeps_subtotal(self) -> None:
        self.assertEqual(calculate_total(75.0, 0.0), 75.0)

    def test_fractional_values_are_preserved(self) -> None:
        self.assertAlmostEqual(calculate_total(10.5, 0.1), 11.55)


if __name__ == "__main__":
    unittest.main()

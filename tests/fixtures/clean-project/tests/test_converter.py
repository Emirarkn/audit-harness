import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cli import main  # noqa: E402
from converter import ConversionError, convert  # noqa: E402


class TemperatureTests(unittest.TestCase):
    def test_c_to_f(self):
        self.assertAlmostEqual(convert(100, "C", "F"), 212.0)

    def test_f_to_c(self):
        self.assertAlmostEqual(convert(32, "F", "C"), 0.0)

    def test_c_to_k(self):
        self.assertAlmostEqual(convert(0, "C", "K"), 273.15)

    def test_k_to_f(self):
        self.assertAlmostEqual(convert(0, "K", "F"), -459.67)

    def test_below_absolute_zero(self):
        with self.assertRaises(ConversionError):
            convert(-300, "C", "K")


class LengthTests(unittest.TestCase):
    def test_km_to_mi(self):
        self.assertAlmostEqual(convert(5, "km", "mi"), 3.106856, places=6)

    def test_ft_to_m(self):
        self.assertAlmostEqual(convert(1, "ft", "m"), 0.3048)

    def test_m_to_km(self):
        self.assertAlmostEqual(convert(1500, "m", "km"), 1.5)

    def test_negative_length(self):
        with self.assertRaises(ConversionError):
            convert(-1, "m", "ft")


class CliTests(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(main(["100", "C", "F"]), 0)

    def test_not_a_number(self):
        self.assertEqual(main(["abc", "C", "F"]), 2)

    def test_non_finite(self):
        for v in ("nan", "inf", "1e999"):
            self.assertEqual(main([v, "C", "F"]), 2, v)

    def test_unknown_unit(self):
        self.assertEqual(main(["1", "C", "parsec"]), 2)

    def test_mixed_dimensions(self):
        self.assertEqual(main(["1", "C", "km"]), 2)


if __name__ == "__main__":
    unittest.main()

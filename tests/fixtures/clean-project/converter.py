"""Pure conversion functions. No I/O."""

ABSOLUTE_ZERO = {"C": -273.15, "F": -459.67, "K": 0.0}

# metres per unit
LENGTH_FACTORS = {"m": 1.0, "km": 1000.0, "mi": 1609.344, "ft": 0.3048}


class ConversionError(ValueError):
    """Raised for unknown units or physically impossible values."""


def convert_temperature(value: float, src: str, dst: str) -> float:
    if src not in ABSOLUTE_ZERO or dst not in ABSOLUTE_ZERO:
        raise ConversionError(f"unknown temperature unit: {src if src not in ABSOLUTE_ZERO else dst}")
    if value < ABSOLUTE_ZERO[src]:
        raise ConversionError(f"{value} {src} is below absolute zero")
    celsius = {"C": value, "F": (value - 32) * 5 / 9, "K": value - 273.15}[src]
    return {"C": celsius, "F": celsius * 9 / 5 + 32, "K": celsius + 273.15}[dst]


def convert_length(value: float, src: str, dst: str) -> float:
    if src not in LENGTH_FACTORS or dst not in LENGTH_FACTORS:
        raise ConversionError(f"unknown length unit: {src if src not in LENGTH_FACTORS else dst}")
    if value < 0:
        raise ConversionError("length cannot be negative")
    return value * LENGTH_FACTORS[src] / LENGTH_FACTORS[dst]


def convert(value: float, src: str, dst: str) -> float:
    if src in ABSOLUTE_ZERO and dst in ABSOLUTE_ZERO:
        return convert_temperature(value, src, dst)
    if src in LENGTH_FACTORS and dst in LENGTH_FACTORS:
        return convert_length(value, src, dst)
    raise ConversionError(f"cannot convert {src} to {dst}")

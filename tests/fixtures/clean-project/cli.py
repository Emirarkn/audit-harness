"""Command-line entry point: python cli.py <value> <from> <to>"""
import argparse
import math
import sys

from converter import ConversionError, convert


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Offline unit converter")
    parser.add_argument("value", help="number to convert")
    parser.add_argument("src", help="source unit (C F K m km mi ft)")
    parser.add_argument("dst", help="target unit")
    args = parser.parse_args(argv)
    try:
        value = float(args.value)
    except ValueError:
        value = math.nan
    if not math.isfinite(value):
        print(f"error: '{args.value}' is not a finite number", file=sys.stderr)
        return 2
    try:
        result = convert(value, args.src, args.dst)
    except ConversionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(round(result, 6))
    return 0


if __name__ == "__main__":
    sys.exit(main())

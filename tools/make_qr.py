"""Make the QR code for the live site.

Usage:
    pip install segno
    python3 tools/make_qr.py https://YOUR-NAME.github.io/YOUR-REPO/

Writes qr/community-creche-qr.svg (scales to any print size) and qr/community-creche-qr.png.
"""
import sys
from pathlib import Path

import segno

INK = "#4a0b13"  # deep maroon from the flyer; dark enough for any phone camera
OUT = Path(__file__).resolve().parent.parent / "qr"


def main() -> None:
    if len(sys.argv) != 2 or not sys.argv[1].startswith("https://"):
        sys.exit("Usage: python3 tools/make_qr.py https://YOUR-NAME.github.io/YOUR-REPO/")

    url = sys.argv[1]
    OUT.mkdir(exist_ok=True)

    # Error level Q survives a bit of smudging or a logo-sized scuff on a printed flyer.
    qr = segno.make(url, error="q")
    qr.save(OUT / "community-creche-qr.svg", scale=10, border=4, dark=INK, light="#ffffff")
    qr.save(OUT / "community-creche-qr.png", scale=24, border=4, dark=INK, light="#ffffff")
    print(f"QR code for {url}")
    print(f"  {OUT / 'community-creche-qr.svg'}")
    print(f"  {OUT / 'community-creche-qr.png'}")


if __name__ == "__main__":
    main()

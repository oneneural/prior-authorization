#!/usr/bin/env python3
"""Write browser-framed HTML wrappers for the raw README screenshots.

No imaging library is assumed, so the frame is drawn in CSS: each wrapper
embeds one raw capture under a neutral window bar that shows the loopback URL
it was taken from. Capture the `#frame` element of each wrapper to produce the
framed PNG (see README.md in this directory). Standard library only.
"""

import argparse
import base64
import html
import struct
from pathlib import Path

HERE = Path(__file__).resolve().parent
ORIGIN = "http://127.0.0.1:3105"

# Raw capture name -> path it was captured from.
CAPTURES = {
    "01-operator-queue": "/",
    "02-case-evidence": "/cases/case-f02-loop",
    "03-source-view": "/cases/case-f02-loop/sources/f01-encounter/1?locator=%2FencounterDate",
    "04-reviewer-packet": "/cases/case-f02-loop/packet",
}

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{name}</title>
<style>
  html, body {{ margin: 0; background: #ffffff; }}
  #frame {{ display: inline-block; padding: 24px; background: #e5e7eb; }}
  .window {{ width: {width}px; border: 1px solid #c4c8cf; border-radius: 10px; overflow: hidden;
            background: #ffffff; box-shadow: 0 6px 20px rgba(17, 24, 39, 0.18); }}
  .bar {{ display: flex; align-items: center; gap: 16px; height: 44px; padding: 0 16px;
         background: #f3f4f6; border-bottom: 1px solid #d1d5db; }}
  .dots {{ display: flex; gap: 8px; }}
  .dots span {{ width: 12px; height: 12px; border-radius: 50%; background: #c4c8cf; }}
  .url {{ flex: 1; height: 28px; line-height: 28px; padding: 0 14px; border-radius: 14px;
         background: #ffffff; border: 1px solid #d1d5db; color: #374151;
         font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
  img {{ display: block; width: {width}px; height: {height}px; }}
</style>
</head>
<body>
<div id="frame"><div class="window">
  <div class="bar"><div class="dots"><span></span><span></span><span></span></div>
    <div class="url">{url}</div></div>
  <img alt="" src="data:image/png;base64,{data}">
</div></div>
</body>
</html>
"""


def png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("not a PNG file")
    return struct.unpack(">II", data[16:24])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raw", type=Path, default=HERE / "raw", help="directory of raw captures")
    parser.add_argument("--out", type=Path, required=True, help="directory for the HTML wrappers")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name, path in CAPTURES.items():
        data = (args.raw / f"{name}.png").read_bytes()
        width, height = png_size(data)
        page = TEMPLATE.format(
            name=html.escape(name),
            url=html.escape(ORIGIN + path),
            width=width,
            height=height,
            data=base64.b64encode(data).decode("ascii"),
        )
        (args.out / f"{name}.html").write_text(page, encoding="utf-8")
        print(f"{args.out / (name + '.html')}: {width}x{height}")


if __name__ == "__main__":
    main()

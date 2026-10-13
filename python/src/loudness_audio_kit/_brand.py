"""Portable canonical brand geometry, without website fonts or downloads."""

import html
import json
from pathlib import Path


def brand_svg() -> str:
    directory = Path(__file__).parent / "brand"
    mark = json.loads((directory / "mark.json").read_text())
    wordmark = json.loads((directory / "wordmark.json").read_text())
    bg = mark["background"]
    bars = "".join(
        f'<line x1="{b["x"]}" x2="{b["x"]}" y1="{mark["centerY"] - b["height"] / 2}" y2="{mark["centerY"] + b["height"] / 2}"/>'
        for b in mark["bars"]
    )
    words = "".join(
        f'<path d="{html.escape(g["d"], quote=True)}" transform="translate({g["x"]} 0)" fill="{g["color"]}"/>'
        for g in wordmark["glyphs"]
    )
    scale = 191 / wordmark["advance"]
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 226 32" role="img" aria-label="Loudness.ai">'
        f'<g transform="translate(0 3)"><rect x="{bg["x"]}" y="{bg["y"]}" width="{bg["width"]}" height="{bg["height"]}" rx="{bg["radius"]}" fill="{bg["color"]}"/>'
        f'<g stroke="{mark["color"]}" stroke-width="{mark["strokeWidth"]}" stroke-linecap="round">{bars}</g></g>'
        f'<g transform="translate(35 27) scale({scale} {-scale})">{words}</g></svg>'
    )

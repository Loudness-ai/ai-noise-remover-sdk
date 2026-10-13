"""Check delivered archive boundaries, metadata and exact local asset equality."""

import argparse
import hashlib
import json
import re
import tarfile
import tomllib
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--receipt", type=Path, default=Path("artifacts/archive-check.json"))
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
version = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]
dist_info = f"loudness_audio_kit-{version}.dist-info"
wheel = root / f"dist/loudness_audio_kit-{version}-py3-none-any.whl"
source = root / f"dist/loudness_audio_kit-{version}.tar.gz"
readme = (root / "README.md").read_text()
assert "python -m pip install loudness-audio-kit" in readme
assert not re.search(r"\]\((?!https?://|#)[^)]+\)", readme), "Relative README link breaks on PyPI"
with zipfile.ZipFile(wheel) as archive:
    members = archive.namelist()
    assert all(not Path(n).is_absolute() and ".." not in Path(n).parts for n in members)
    assert all(n.startswith(("loudness_audio_kit/", f"{dist_info}/")) for n in members)
    assert not any(n.endswith((".pyc", ".wav", ".ogg")) or "/tests/" in n for n in members)
    for n in members:
        if n.startswith("loudness_audio_kit/"):
            assert archive.read(n) == (root / "src" / n).read_bytes(), n
    metadata = archive.read(f"{dist_info}/METADATA").decode()
    assert f"Version: {version}\n" in metadata
    assert "Requires-Python: <3.15,>=3.11" in metadata
    assert "License-Expression: LicenseRef-Loudness-Audio-Kit-Distribution" in metadata
    assert "Requires-Dist: onnxruntime==1.30.0" in metadata
with tarfile.open(source) as archive:
    files = [m.name for m in archive.getmembers() if m.isfile()]
    assert all(not Path(n).is_absolute() and ".." not in Path(n).parts for n in files)
    for member in archive.getmembers():
        assert not member.issym() and not member.islnk()
        if member.isfile() and "/src/loudness_audio_kit/" in member.name:
            handle = archive.extractfile(member)
            assert handle is not None
            assert handle.read() == root.joinpath(*Path(member.name).parts[1:]).read_bytes(), (
                member.name
            )
    assert not any(
        "/artifacts/" in n or "/.venv/" in n or "/site-assets/" in n or n.endswith("AGENTS.md")
        for n in files
    )
    for required in (
        "tests/test_processing.py",
        "examples/fixtures/narration-a.ogg",
        "docs/verification.md",
    ):
        assert any(n.endswith(required) for n in files), required
receipt = {
    "passed": True,
    "wheel_members": len(members),
    "source_members": len(files),
    "source_and_wheel_code_assets_equal": True,
    "private_website_source_included": False,
    "assets": [
        {
            "file": p.name,
            "bytes": p.stat().st_size,
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
        }
        for p in (wheel, source)
    ],
}
args.receipt.parent.mkdir(parents=True, exist_ok=True)
args.receipt.write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt, indent=2))

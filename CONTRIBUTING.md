# Contributing

Choose the edition affected by your change. Both use local audio processing;
keep source protection, complete recording tails, bounded resources and physical
cancellation cleanup intact. Do not replace actual inference with API mocks or
relax output/cleanup assertions to hide a regression.

## JavaScript and TypeScript

Use Node.js 22 or 24 and FFmpeg/FFprobe:

```sh
cd javascript
npm ci --ignore-scripts
npm ci --prefix demo --ignore-scripts
npm test
npm run test:types
npm run check:schemas
npm run verify:package
npm run lint
```

## Python

Use Python 3.11–3.14, a virtual environment and FFmpeg/FFprobe:

```sh
cd python
python -m pip install -e '.[dev]'
ruff check src tests scripts examples
ruff format --check src tests scripts examples
mypy src
pytest -q
python -m build
twine check dist/*
python scripts/release_check.py
```

Document behavioral changes, API differences and the platforms actually tested.
Codec or processing changes require decoded-output evidence. Preserve original
component attribution and review compatible model assets deliberately.

Bug reports should identify the edition, package version, runtime, operating
system, native tools and a minimal reproducible example. Use generated or
rights-cleared audio; never attach customer recordings, credentials or private
logs. Report vulnerabilities using [SECURITY.md](SECURITY.md).

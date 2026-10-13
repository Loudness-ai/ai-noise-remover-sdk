# Changelog

## 1.0.1 — 2026-10-13

- Use the public PyPI installation command in the package description.
- Describe documentation included in the source distribution without broken relative links on PyPI.
- Preserve all processing behavior, model assets and component terms from 1.0.0.

## Public release preparation — 2026-10-13

- Include the component distribution record and pinned upstream code license texts in Python packaging.
- Identify the exact model-dfn3-512-v1 release by graph checksum and bitwise initial-state comparison; include deepfilter-stream's original license and attribution.
- Document the MIT interpretation of the published component terms without claiming separate original-author weight confirmation.
- Preserve the existing local engine and processing behavior. Publication is verified separately from package preparation.

## 1.0.0 — 2026-10-13

- Native Python edition of the completed local Audio Kit, using the same pinned CPU assets without Node.js or a hosted API.
- Full-duration denoise/enhance/normalize/convert, verified WAV/FLAC/MP3/Opus exports, configurable resource limits and atomic output.
- Bounded shared client, ordered batches, queued/active cancellation and asynchronous cleanup fencing.
- Inspection, loudness/signal measurement, explicit policies, bounded comparison, offline reports, trusted benchmarks and diagnostics.
- Typed SDK, CLI, examples, source/wheel delivery and actual processing/installation evidence. Public publication remains separate from this local build.

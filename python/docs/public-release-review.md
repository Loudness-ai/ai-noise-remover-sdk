# Public release review — 13 October 2026

## Distribution decision

Keep Loudness.ai's original Python code under MIT and preserve the complete
local noise-removal/enhancement engine. Retain verbatim DeepFilterNet and
deepfilter-stream license/attribution texts and pinned source records.
The component record elects MIT on the reading of the published upstream
repository and model-export terms; it does not claim an additional original
author statement specifically covering pretrained weights.

## Newly established source evidence

The model graph's SHA-256 matches deepfilter-stream's model-dfn3-512-v1 release
and its pinned source metadata. Every array in the release initial_states.npz
matches the locally packed state file bitwise. Download source identity is
therefore established. Runtime source, model bytes and behavior are unchanged.

The export publisher's NOTICE describes the 512-hop / 1024-FFT fine-tuned
torchDF model and attributes it to DeepFilterNet under MIT/Apache-2.0.
third-party/deepfilter-stream/source-record.json records the release and
notice checksums. Its original LICENSE and NOTICE are included in the wheel's
license directory and in the source archive.

## Remaining distinctions

The original README expressly describes code, and its pretrained-weight scope
questions remain unanswered at the dated check. The elected interpretation
is documented in DISTRIBUTION-LICENSE and docs/provenance.md. No separate
original-author weight confirmation or reproducible training/fine-tuning
recipe is claimed. Silence is not treated as additional permission.

The earlier local review archives remain preserved. New distribution archives
and packaging/install checks are recorded separately; no new native Windows
verification is implied. Publication requires the intended publisher's upload
authentication and is only reported after the live PyPI files and hashes are
verified. A package build alone does not establish public upload.

## Sources

- [DeepFilterNet root license](https://github.com/Rikorose/DeepFilterNet/blob/d375b2d8309e0935d165700c91da9de862a99c31/LICENSE)
- [Exact model release](https://github.com/wuxuedaifu/deepfilter-stream/releases/tag/model-dfn3-512-v1)
- [Pinned model metadata](https://github.com/wuxuedaifu/deepfilter-stream/blob/be1a989760c93f3107c0c39a6d866df8d6bd40b2/src/deepfilter_stream/_meta.py)
- [Export publisher NOTICE](https://github.com/wuxuedaifu/deepfilter-stream/blob/be1a989760c93f3107c0c39a6d866df8d6bd40b2/NOTICE)
- [Upstream weight-scope question](https://github.com/Rikorose/DeepFilterNet/issues/700)

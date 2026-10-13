# Public distribution record — 13 October 2026

The package preserves Loudness.ai's local noise-removal and enhancement engine,
with no hosted API, replacement model or feature removal. Wrapper code remains
MIT. The npm license field points to `DISTRIBUTION-LICENSE`, which records the
terms of each bundled component rather than labeling all assets as original
Loudness.ai MIT work.

## Verified component source

The ONNX graph matches wuxuedaifu/deepfilter-stream's `model-dfn3-512-v1` release
by its full SHA-256. Every release NPZ initial-state array matches the package's
concatenated little-endian float32 state file bitwise. The original exporter
LICENSE, NOTICE, pinned revision and source hashes are included under
`third-party/deepfilter-stream`.

- Graph SHA-256: `b758c49d6708a5b7979e3de185705a8a4915076c862fb17b1b304d9a72b75cdc`.
- Packed initial-state SHA-256: `7664728d90e7b17655cf4d308d46d42fdea6c3a69c374e494164c7cb44d783fc`.
- Exporter revision: `be1a989760c93f3107c0c39a6d866df8d6bd40b2`.
- Original DeepFilterNet code-notice revision: `d375b2d8309e0935d165700c91da9de862a99c31`.

The export publisher attributes the 512-hop / 1024-FFT fine-tuned torchDF model
to DeepFilterNet under MIT/Apache-2.0. This distribution elects the MIT option on
that published reading and retains all original attribution. No separately
obtained original-author pretrained-weight confirmation or new grant is claimed.
The original training checkpoint and fine-tuning recipe remain unverified. The
exact exported model release is established; it is distinct from reproducible
training provenance. See `provenance.md` and `DISTRIBUTION-LICENSE`.

## Release validation

The dated release receipt records the exact tarball, archive members, unchanged
runtime/model hashes and installed JavaScript/TypeScript/CLI consumers. Public
registry upload and fresh registry installation are recorded separately in the
publication receipt; a prepared archive alone is not evidence of publication.
Historical platform and quality evidence is identified in `verification.md`.
Native Windows execution and universal perceptual-quality claims are not asserted.

The JavaScript package is named `loudness-audio-kit` and links to
[the Loudness.ai website](https://loudness.ai/). It is independent of the Python
package with the same public name on PyPI.

## Primary references

- [Exact exported model release](https://github.com/wuxuedaifu/deepfilter-stream/releases/tag/model-dfn3-512-v1)
- [Original export notice](https://github.com/wuxuedaifu/deepfilter-stream/blob/be1a989760c93f3107c0c39a6d866df8d6bd40b2/NOTICE)
- [DeepFilterNet code license](https://github.com/Rikorose/DeepFilterNet/blob/d375b2d8309e0935d165700c91da9de862a99c31/LICENSE)

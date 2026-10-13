# Provenance and redistribution

Loudness.ai's native Python adapter, lifecycle, scheduler, CLI, reports and documentation use the included MIT code license. This does not claim authorship or MIT relicensing of an upstream pretrained model. Keep LICENSE and NOTICE with copies. Optional project attribution does not impose a backlink requirement.

The Python edition reuses the exact graph, initial-state bytes and manifest from the completed JavaScript kit. It does not replace the existing CPU engine, call a hosted API or download another checkpoint. Runtime checks enforce the original 48 kHz, 512-sample and recurrent-state contract.

| Asset | Bytes | SHA-256 |
| --- | --- | --- |
| `denoiser_model.onnx` | 12911035 | `b758c49d6708a5b7979e3de185705a8a4915076c862fb17b1b304d9a72b75cdc` |
| `initial_states.bin` | 184544 | `7664728d90e7b17655cf4d308d46d42fdea6c3a69c374e494164c7cb44d783fc` |

## Verified model release source

The graph matches [wuxuedaifu/deepfilter-stream's model-dfn3-512-v1 release](https://github.com/wuxuedaifu/deepfilter-stream/releases/tag/model-dfn3-512-v1) by its full SHA-256. The graph hash is also pinned in that publisher's [`_meta.py`](https://github.com/wuxuedaifu/deepfilter-stream/blob/be1a989760c93f3107c0c39a6d866df8d6bd40b2/src/deepfilter_stream/_meta.py). Its release `initial_states.npz` has SHA-256 `1165503707b8859a6b650b6bb0dc5b6c55d30c2779d87502f97a77102b5d3872`; every array was compared bitwise with this package's concatenated little-endian float32 state data. Both model files remain unchanged.

The publisher's original [NOTICE](https://github.com/wuxuedaifu/deepfilter-stream/blob/be1a989760c93f3107c0c39a6d866df8d6bd40b2/NOTICE) attributes the 512-hop / 1024-FFT fine-tuned torchDF model to DeepFilterNet under MIT/Apache-2.0. Its original MIT license, attribution and pinned source hashes are retained in `third-party/deepfilter-stream`. DeepFilterNet's original code notices are retained in `third-party/DeepFilterNet`.

## Adopted licensing interpretation and limits

This distribution elects the MIT option on the reading that the published repository and model-export terms cover the distributed model. The model is attributed to its upstream authors, rather than presented as Loudness.ai's own MIT model. This is the distribution's stated interpretation; it is not an independently obtained grant from the original model author.

The original README expressly describes code. [Issue 700](https://github.com/Rikorose/DeepFilterNet/issues/700) and [issue 709](https://github.com/Rikorose/DeepFilterNet/issues/709) remain open questions about pretrained-weight scope, without a maintainer clarification at the 13 October 2026 check. Absence of a reply is not used as a grant. The exact original training checkpoint and fine-tuning recipe have not been verified. The model release source is established; that should not be confused with reproducible training provenance or explicit weight-scope confirmation.

The [grazder torchDF reference](https://github.com/grazder/DeepFilterNet/tree/torchDF-changes), revision `1097015d53ced78fb234e7d7071a5dd4446e3952`, differs in frame/state packing and is not claimed to recreate this binary. Package metadata retains `LicenseRef-Loudness-Audio-Kit-Distribution`, pointing to the component record rather than obscuring these distinctions behind an MIT-only label.

NumPy, SciPy, ONNX Runtime (pinned at 1.30.0) and psutil retain their own licenses and bundled third-party notices. Platform-specific dependency wheels provide native CPU binaries. FFmpeg/FFprobe are external tools; their license and codec-patent implications depend on the selected build. The verification Dockerfile installs Debian's FFmpeg and does not relicense it.

The source archive contains two unmodified CC-BY-4.0 LibriSpeech/LibriVox excerpts, with source URLs, hashes and credits in `examples/fixtures/provenance.json`: Garth Comira reading Ashiel Mystery, chapter 2, and Heather Barnett reading Sense and Sensibility, chapter 18. Unit-test synthesized tones/noise are generated locally. These fixtures are regression evidence, not a representative perceptual-quality corpus. The wheel excludes examples/tests and the site's private fonts/source.

See the [public release review](public-release-review.md) for the package preparation and verification boundary. The separate dated publication receipt records any actual public upload; a local build is not evidence of publication.

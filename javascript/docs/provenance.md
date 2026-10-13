# Provenance and redistribution

Loudness.ai's JavaScript/TypeScript adapter, lifecycle, scheduler, CLI, reports and documentation use the included MIT code license. This does not claim authorship or MIT relicensing of an upstream pretrained model. Keep LICENSE and NOTICE with copies. Optional project attribution does not impose a backlink requirement.

This JavaScript/TypeScript edition uses the same verified graph and initial-state bytes as the Python edition. It does not replace the existing CPU engine, call a hosted API or download another checkpoint. Runtime checks enforce the original 48 kHz, 512-sample and recurrent-state contract.

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

The [grazder torchDF reference](https://github.com/grazder/DeepFilterNet/tree/torchDF-changes), revision `1097015d53ced78fb234e7d7071a5dd4446e3952`, differs in frame/state packing and is not claimed to recreate this binary. Package metadata uses `SEE LICENSE IN DISTRIBUTION-LICENSE`, pointing to the component record rather than obscuring these distinctions behind an MIT-only label.

## Native runtime and codecs

`onnxruntime-node`1.30.0 is a pinned MIT dependency; its installed distribution includes Microsoft and third-party notices. It supplies platform-native CPU inference. No GPU or paid inference service is required. Node/runtime package installation can access registries; audio processing itself makes no network requests.

FFmpeg/FFprobe are external executables. Their distribution licenses and codec patents depend on the adopter's native build. The demo container installs Debian's FFmpeg through its package manager; it does not relicense FFmpeg. Review the chosen native distribution before redistributing a Docker image or executable bundle.

Busboy1.6.0 and streamsearch are MIT demo dependencies. TypeScript, Node type declarations, Prettier and Ajv are development dependencies. Their notices remain in their respective installed packages; production Docker prunes development dependencies.

## Fixtures and branding

`examples/fixtures/provenance.json` identifies the CC-BY-4.0 LibriSpeech/LibriVox narration excerpts, speakers, source URLs, license and checksums. Narration A: Garth Comira reading Ashiel Mystery, chapter 2. Narration B: Heather Barnett reading Sense and Sensibility, chapter 18. `demo/speech-example.wav` is a derivative of narration A with deterministic added white noise; the seed/generation logic is in `scripts/processing-evidence.mjs`. The synthetic calibrated `demo/sample.wav` is CC0-1.0. The evidence excerpts are narrow regressions, not a representative quality corpus.

Canonical Loudness.ai mark/wordmark geometry is supplied by Loudness.ai. The package does not redistribute the site's font files or private website source. Rights notices and hashes are recorded for reviewer inspection; nothing implies that upstream algorithms were invented by Loudness.ai.


The dated npm publication receipt records the uploaded archive and registry-install checks. Source verification does not by itself imply registry publication.

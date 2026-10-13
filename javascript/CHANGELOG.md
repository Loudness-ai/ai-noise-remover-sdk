# Changelog

## Public release preparation — 2026-10-13

- Add component-aware distribution metadata, pinned upstream code license texts and a public release review.
- Identify the exact model-export release and retain its original LICENSE/NOTICE under the elected MIT interpretation, without claiming separate original-author weight-scope confirmation.
- Publish metadata and examples use `loudness-audio-kit` and the Loudness.ai homepage; processing behavior is unchanged. Actual publication is recorded separately in the dated registry receipt.

## 1.0.0 — 2026-10-13

- Local CPU speech denoising and enhancement with the existing pinned speech graph; no hosted API requirement.
- Streamed frame processing with independent channel state,1536-sample delay compensation and full tail flushing.
- Configurable measured normalization, WAV16/24, FLAC, MP3 and Opus exports, complete decoded validation and atomic output protection.
- Memory/thread admission, configurable concurrency, queued deadlines, process-tree cancellation and temporary-disk cleanup.
- Ordered processing batches, ESM/CommonJS/TypeScript SDK and loudness-audio CLI.
- Actual processed-audio web demo, non-root Docker/Space packaging, reusable audit/measurement/report/benchmark tools.
- Pinned ONNX Runtime1.30.0; source, consumer, native integration, lifecycle and quality evidence.

The prior audit-only work remains supporting functionality; it did not implement the requested local audio processing product. The dated publication receipt records registry upload and installation independently of local build verification.

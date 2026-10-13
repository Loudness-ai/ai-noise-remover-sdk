# Release procedure

1. For runtime changes, run the complete tests, strict consumer types, schema and formatting checks from a clean source copy. Verify Node 22 and 24 on the stated native platforms and record execution evidence. Documentation-only packaging updates retain the separate original platform receipts and explicitly verify runtime/model byte equality.
2. Run `npm run verify:package` in an isolated source snapshot. It builds/packs an allowlisted tarball and installs that exact artifact in an isolated consumer. Exercise ESM, CommonJS, types, actual local processing, CLI modes, measurements and reports.
3. For demo/runtime changes, run non-root Docker/HTTP enhancement, cancellation and browser upload/playback/download checks. Record actual output and cleanup evidence.
4. Keep prior archives and receipts intact. Build a new release candidate separately and verify its full SHA-256, archive boundaries, original component licenses and asset hashes. Never include credentials, website source or local runtime data.
5. Retain the exact exporter source and adopted component-license interpretation documented in `provenance.md`, `DISTRIBUTION-LICENSE` and `third-party`. Native runtime, codec and fixture notices remain applicable. Do not claim a separate original-author weight confirmation or reproducible training recipe.
6. Confirm the intended publisher and package name, and use an existing credential only for the authorized official npm destination. Publish the exact verified tarball, then verify public maintainer/metadata, registry SHA-512 integrity and a fresh installation from the registry with real SDK/CLI processing. Record a publication receipt.

The npm package name is `loudness-audio-kit`; the project homepage is https://loudness.ai/. Preparing archives is not public publication. Native Windows remains an execution boundary; configured CI jobs are not execution receipts. Emulated Linux amd64 checks are packaging evidence rather than native performance benchmarks.

Source, Docker/Space and developer evidence archives are separate from the installable npm runtime. Publish source repositories or Spaces only under their separately authorized identity and destination. Never invent a public repository URL.

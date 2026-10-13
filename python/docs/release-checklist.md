# Release checklist

1. Verify the exact model release hash and initial-state payloads, retain upstream notices, and review the adopted component-licensing interpretation in provenance.md. Do not describe original checkpoint/training provenance or separate weight-scope confirmation as verified. Obtain publication authorization and the intended publisher's upload credentials.
2. Run formatting, lint, typing and the full real-processing suite. Keep duration/tail, channel isolation, corrupt input, output aliases/races, cancellation, resource failures and concurrent jobs covered.
3. Compare the same checked fixtures with the completed JavaScript kit, including actual decoded PCM and measurements. Record platform/runtime/FFmpeg versions and hashes.
4. Process a long recording; verify complete frame count, sampled resources and scratch cleanup. Run repeat-job checks and disk-full failure where available.
5. Build wheel and source archive. Inspect member allowlists and model hashes. Run Twine metadata checks and runtime dependency audit.
6. Install each archive into a fresh environment outside the checkout. Run the consumer and actual processing suite. Verify supported Python boundaries on Linux and the actual macOS runtime. Test Windows before claiming Windows support.
7. Run installed processing without network access. Archive machine-readable evidence, delivery hashes and precise limitations.
8. Only then perform a separately authorized public upload. Verify the live PyPI project/version/install and retain the publication receipt. A built wheel or metadata check does not imply publication.

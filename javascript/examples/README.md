# Runnable integrations

After installing the release tarball, use the package's examples or copy these patterns into your application. Input/output files are local; create the output directory first.

```sh
node examples/process.mjs recording.wav enhanced.wav
node examples/analyze.mjs recording.wav measurements.html
node examples/commonjs.cjs recording.wav
```

`process.mjs` performs real enhancement and prints the actual output summary. `processing-service.cjs` demonstrates one shared owner-scoped client and request-disconnect cancellation; the application still owns retention/deletion of its uploaded inputs and completed outputs. `processing-jobs.json` illustrates the ordered CLI batch manifest; replace paths before execution.

`typescript.mts` shows strict audit types; the package's declaration consumer checks also exercise processing/batch types. `request-cancellation.cjs` demonstrates audit request ownership. `browser-recording.html` captures a browser recording for export into a local workflow; it is not a browser inference runtime.

Fixture credit and checksums are in `fixtures/provenance.json`. Generated HTML reports contain measurements, not processed audio. Use enhance/denoise to create the audio, then analyze/compare/report when measurements are useful.

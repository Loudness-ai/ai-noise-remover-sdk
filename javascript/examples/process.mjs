import { enhance } from "loudness-audio-kit";
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error("Usage: node examples/process.mjs INPUT OUTPUT");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const result = await enhance(input, output, { signal: controller.signal });
  console.log(
    JSON.stringify(
      {
        output: result.output,
        lufs: result.analysis.integratedLufs,
        warnings: result.warnings,
      },
      null,
      2,
    ),
  );
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

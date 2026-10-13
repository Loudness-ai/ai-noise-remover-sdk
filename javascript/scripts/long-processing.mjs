import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, cpus } from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { denoise } = require("../dist/cjs/index.js");
const { run } = require("../dist/cjs/process.js");
const folder = await mkdtemp(join(tmpdir(), "kit-hour-"));
const seconds = 3600;
try {
  const input = join(folder, "input.wav"),
    output = join(folder, "output.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=16000",
    "-t",
    String(seconds),
    "-c:a",
    "pcm_s16le",
    input,
  ]);
  const result = await denoise(input, output, { tempDirectory: folder });
  if (
    result.analysis.frames !== seconds * 16000 ||
    result.output.durationSeconds !== seconds
  )
    throw Error("The one-hour recording was truncated.");
  await mkdir("artifacts", { recursive: true });
  const evidence = {
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
    },
    seconds,
    frames: result.analysis.frames,
    outputRate: result.output.sampleRate,
    metrics: result.metrics,
    result: "passed",
  };
  await writeFile(
    "artifacts/one-hour-processing.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await rm(folder, { recursive: true, force: true });
}

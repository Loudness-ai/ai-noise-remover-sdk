import {
  doctor,
  inspect,
  validate,
  compare,
  batch,
  examplePolicy,
} from "loudness-audio-kit/core";
import { benchmark } from "loudness-audio-kit/benchmark";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const [before, after = before] = process.argv.slice(2);
if (!before)
  throw new Error("Usage: node workflows.mjs original.wav [processed.wav]");
console.log("inspection", await inspect(before));
console.log("policy", await validate(after, examplePolicy));
console.log("comparison", await compare(before, after));
console.log(
  "batch",
  await batch([before, after], { concurrency: 4, maxPoints: 64 }),
);
const dependencies = await doctor();
if (!dependencies.ready)
  throw new Error("Measurement dependencies are unavailable.");
const hash = createHash("sha256")
  .update(await readFile(before))
  .digest("hex");
console.log(
  "benchmark",
  await benchmark(
    {
      schemaVersion: 1,
      fixtures: [
        {
          path: before,
          sha256: hash,
          license: "Developer-supplied private fixture; not redistributed",
        },
      ],
      processors: [
        {
          name: "PCM conversion",
          executable: "ffmpeg",
          args: [
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            "{input}",
            "-c:a",
            "pcm_s16le",
            "{output}",
          ],
          version: dependencies.versions.ffmpeg,
          settings: { codec: "pcm_s16le" },
        },
      ],
      repetitions: 2,
      warmup: 0,
      comparison: true,
    },
    { allowExecution: true },
  ),
);

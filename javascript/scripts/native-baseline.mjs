import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { analyze, doctor } = require("../dist/cjs/core.js");
const folder = await mkdtemp(join(tmpdir(), "audit-native-baseline-"));
await mkdir("artifacts", { recursive: true });
const execute = (args) => {
  const start = performance.now();
  const result = spawnSync("ffmpeg", args, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (result.status !== 0)
    throw Error(`Native baseline failed with exit ${result.status}.`);
  return performance.now() - start;
};
const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
try {
  const fixtures = [];
  for (const seconds of [10, 60, 1200]) {
    const file = join(folder, "baseline.wav");
    execute([
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=16000:duration=${seconds}`,
      "-c:a",
      "pcm_s16le",
      "-y",
      file,
    ]);
    const args = [
      "-hide_banner",
      "-nostdin",
      "-v",
      "info",
      "-threads",
      "1",
      "-i",
      file,
      "-filter_threads",
      "1",
      "-filter_complex_threads",
      "1",
      "-af",
      "ebur128=peak=true",
      "-c:a",
      "pcm_f64le",
      "-f",
      "f64le",
      "pipe:1",
    ];
    // Warm both paths; no claim of cold filesystem/model cache is made.
    execute(args);
    await analyze(file, { nativeThreads: 1, maxPoints: 256 });
    const directMs = [],
      sdkMs = [];
    for (let i = 0; i < 5; i++) {
      const native = () => directMs.push(execute(args));
      const sdk = async () => {
        const start = performance.now();
        const r = await analyze(file, { nativeThreads: 1, maxPoints: 256 });
        sdkMs.push(performance.now() - start);
        if (r.frames !== seconds * 16000) throw Error("SDK coverage mismatch");
      };
      if (i % 2) {
        await sdk();
        native();
      } else {
        native();
        await sdk();
      }
    }
    fixtures.push({
      seconds,
      sampleRate: 16000,
      channels: 1,
      nativeThreads: 1,
      runs: 5,
      directMs,
      sdkMs,
      directMedianMs: median(directMs),
      sdkMedianMs: median(sdkMs),
      additionalSdkMedianMs: median(sdkMs) - median(directMs),
    });
  }
  const receipt = {
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      dependencies: await doctor(),
    },
    fixtures,
    method:
      "Interleaved launches after one warmup per path. Direct FFmpeg decodes float64 PCM and computes ebur128 true peak/loudness; PCM is discarded. SDK adds inspection, streamed sample statistics, hashes, quiet/event/band summaries and bounded charts. The additional time includes those extra features and pipe consumption; these are not feature-equivalent tasks or a competitor ranking.",
  };
  await writeFile(
    "artifacts/native-baseline.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await rm(folder, { recursive: true, force: true });
}

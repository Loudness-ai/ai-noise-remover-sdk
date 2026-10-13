import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { run } = require("../dist/cjs/process.js");
const { analyze, batch } = require("../dist/cjs/index.js");
const scratch = await mkdtemp(join(tmpdir(), "audio-audit-long-"));
await mkdir("artifacts", { recursive: true });
const results = [];
try {
  for (const seconds of [10, 60, 1200, 7200]) {
    const file = join(scratch, "input.wav");
    const generation = spawnSync("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
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
    if (generation.status !== 0) throw Error(generation.stderr.toString());
    const childCode = `const {analyze}=require(${JSON.stringify(require.resolve("../dist/cjs/index.js"))});analyze(process.argv[1],{maxPoints:256,maxDurationSeconds:8000}).then(r=>console.log(JSON.stringify({frames:r.frames,durationSeconds:r.durationSeconds,waveformPoints:r.waveform.length,loudnessPoints:r.loudnessTimeline.length,coverageEnd:r.waveform.at(-1).endSeconds}))).catch(e=>{console.error(e);process.exitCode=1});`;
    const native = await run(process.execPath, ["-e", childCode, file], {
      measure: true,
      timeoutMs: 600000,
    });
    const report = JSON.parse(native.stdout);
    if (
      report.frames !== seconds * 16000 ||
      report.coverageEnd !== seconds ||
      report.waveformPoints > 256 ||
      report.loudnessPoints > 256
    )
      throw Error("Long-file coverage/bounds failed.");
    results.push({
      seconds,
      sampleRate: 16000,
      ...report,
      metrics: native.metrics,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  const short = join(scratch, "short.wav");
  spawnSync("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=1",
    "-y",
    short,
  ]);
  const soak = [],
    checkpoints = [];
  for (let i = 0; i < 100; i++) {
    await analyze(short);
    soak.push(process.memoryUsage().rss);
    if (typeof global.gc === "function" && (i + 1) % 10 === 0) {
      global.gc();
      checkpoints.push({ jobs: i + 1, ...process.memoryUsage() });
    }
  }
  if (
    checkpoints.length &&
    (checkpoints.at(-1).heapUsed - checkpoints[0].heapUsed > 8 * 1024 * 1024 ||
      checkpoints.at(-1).rss - checkpoints[0].rss > 64 * 1024 * 1024)
  )
    throw Error(
      "Repeated-job retained memory exceeded the diagnostic regression budget.",
    );
  const concurrent = await batch(Array(12).fill(short), { concurrency: 6 });
  if (concurrent.results.some((r) => r.state !== "completed"))
    throw Error("Concurrent check failed.");
  await writeFile(
    "artifacts/long-file-evidence.json",
    JSON.stringify(
      {
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpu: cpus()[0]?.model,
        },
        results,
        soakRssBytes: soak,
        retainedMemoryCheck: {
          checkpoints,
          forcedGc: typeof global.gc === "function",
          heapGrowthBudgetBytes: 8 * 1024 * 1024,
          rssGrowthBudgetBytes: 64 * 1024 * 1024,
          scope:
            "100 one-second jobs; checkpoints after explicit diagnostic GC. Budgets detect regressions for this fixture, not a universal memory guarantee.",
        },
        concurrency: 6,
        jobs: 12,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

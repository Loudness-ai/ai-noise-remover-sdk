import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  mkdir,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { denoise, enhance, analyze } = require("../dist/cjs/index.js");
const { run } = require("../dist/cjs/process.js");
const { wav, noise } = require("../tests/fixtures.cjs");
await mkdir("artifacts", { recursive: true });
const dir = await mkdtemp(join(tmpdir(), "kit-evidence-"));
const decode = async (file) =>
  (
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { maxStdoutBytes: 8 * 1024 * 1024 },
    )
  ).stdout;
function samples(bytes) {
  return Float32Array.from({ length: bytes.length / 4 }, (_, i) =>
    bytes.readFloatLE(i * 4),
  );
}
function sisdr(reference, estimate) {
  let dot = 0,
    energy = 0;
  for (let i = 0; i < reference.length; i++) {
    dot += reference[i] * estimate[i];
    energy += reference[i] ** 2;
  }
  const scale = dot / energy;
  let target = 0,
    residual = 0;
  for (let i = 0; i < reference.length; i++) {
    target += (scale * reference[i]) ** 2;
    residual += (estimate[i] - scale * reference[i]) ** 2;
  }
  return 10 * Math.log10(target / residual);
}
function alignedQuality(reference, estimate) {
  let best = { lag: 0, score: -Infinity };
  const score = (lag) => {
    let dot = 0,
      a = 0,
      b = 0;
    for (let i = 4096; i < reference.length - 4096; i += 32) {
      const x = reference[i],
        y = estimate[i + lag];
      dot += x * y;
      a += x * x;
      b += y * y;
    }
    return dot / Math.sqrt(a * b);
  };
  for (let lag = -4096; lag <= 4096; lag += 8) {
    const value = score(lag);
    if (value > best.score) best = { lag, score: value };
  }
  const center = best.lag;
  for (let lag = center - 7; lag <= center + 7; lag++) {
    const value = score(lag);
    if (value > best.score) best = { lag, score: value };
  }
  const lag = best.lag;
  const from = Math.max(0, -lag),
    to = Math.min(reference.length, estimate.length - lag);
  return {
    correlation: best.score,
    transportLagSamples: lag,
    siSdrDb: sisdr(
      reference.subarray(from, to),
      estimate.subarray(from + lag, to + lag),
    ),
  };
}
try {
  const quality = [];
  for (const fixture of ["narration-a.ogg", "narration-b.ogg"]) {
    const clean = samples(await decode(resolve("examples/fixtures", fixture)));
    const rms = Math.sqrt(
      clean.reduce((sum, v) => sum + v * v, 0) / clean.length,
    );
    const random = noise(121);
    const noisy = new Float32Array(clean.length);
    for (let i = 0; i < clean.length; i++)
      noisy[i] =
        clean[i] + (random() * rms) / 0.08660254037844386 / Math.sqrt(10);
    const input = join(dir, fixture + ".wav"),
      output = join(dir, fixture + "-clean.wav");
    await writeFile(
      input,
      wav({ frames: clean.length, sample: (i) => noisy[i] }),
    );
    const raw = await decode(input);
    const rawPath = join(dir, "input.f32");
    await writeFile(rawPath, raw);
    const result = await denoise(input, output, { tempDirectory: dir });
    const produced = samples(await decode(output));
    const referencePath = join(dir, "reference.f32");
    const reference = await run(
      process.execPath,
      ["scripts/reference-denoiser.cjs", rawPath, referencePath],
      { measure: true },
    );
    const expected = samples(await readFile(referencePath));
    let maxError = 0;
    for (let i = 0; i < expected.length; i++)
      maxError = Math.max(maxError, Math.abs(expected[i] - produced[i]));
    if (maxError > 1 / 32768 + 1e-7 || result.analysis.frames !== clean.length)
      throw Error("Reference mismatch or truncated audio.");
    const nativePath = join(dir, fixture + "-native.wav");
    const nativeNoiseFloorDb = Math.min(
      -20,
      Math.max(-80, 20 * Math.log10(rms / Math.sqrt(10))),
    );
    const native = await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        input,
        "-af",
        `afftdn=nr=12:nf=${nativeNoiseFloorDb}`,
        "-c:a",
        "pcm_s16le",
        nativePath,
      ],
      { measure: true },
    );
    const nativeSamples = samples(await decode(nativePath));
    const alignedKit = alignedQuality(clean, produced),
      alignedNative = alignedQuality(clean, nativeSamples);
    if (Math.abs(alignedKit.transportLagSamples) > 1)
      throw Error("The denoiser has uncorrected transport delay.");
    quality.push({
      fixture,
      inputFrames: clean.length,
      outputFrames: result.analysis.frames,
      inputSiSdrDb: sisdr(clean, noisy),
      denoisedSiSdrDb: sisdr(clean, produced),
      alignedKit,
      alignedNativeAfftdn: alignedNative,
      nativeSettings: {
        filter: "afftdn",
        noiseReductionDb: 12,
        noiseFloorDb: nativeNoiseFloorDb,
      },
      maxAbsoluteDifferenceFromIndependentReference: maxError,
      kit: result.metrics,
      wholeBufferReference: reference.metrics,
      nativeAfftdn: native.metrics,
    });
    await writeFile(
      join("artifacts", fixture.replace(".ogg", "-noisy.wav")),
      await readFile(input),
    );
    await writeFile(
      join("artifacts", fixture.replace(".ogg", "-denoised.wav")),
      await readFile(output),
    );
  }
  let longFile, repeated;
  if (process.env.KIT_QUALITY_ONLY === "1") {
    const previous = JSON.parse(
      await readFile("artifacts/processing-evidence.json", "utf8"),
    );
    longFile = {
      ...previous.longFile,
      recordedAt: previous.longFile.recordedAt ?? previous.date,
    };
    repeated = previous.repeated;
  } else {
    const longSeconds = Number(process.env.KIT_LONG_SECONDS ?? 600);
    const longInput = join(dir, "long.wav"),
      longOutput = join(dir, "long-clean.wav");
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=48000",
      "-t",
      String(longSeconds),
      "-c:a",
      "pcm_s16le",
      longInput,
    ]);
    const long = await denoise(longInput, longOutput, { tempDirectory: dir });
    if (long.analysis.frames !== longSeconds * 48000)
      throw Error("Long recording was truncated.");
    const longRaw = join(dir, "long-input.f32"),
      longReference = join(dir, "long-reference.f32");
    await run("ffmpeg", [
      "-v",
      "error",
      "-i",
      longInput,
      "-f",
      "f32le",
      longRaw,
    ]);
    const referenceLong = await run(
      process.execPath,
      ["scripts/reference-denoiser.cjs", longRaw, longReference],
      { measure: true, timeoutMs: 3600000 },
    );
    const streamingRaw = join(dir, "long-streaming.f32");
    const streamingLong = await run(
      process.execPath,
      [
        "dist/cjs/processing-worker.js",
        JSON.stringify({
          input: longInput,
          output: streamingRaw,
          modelDir: resolve("models/dfn3-512-v1"),
          ffmpeg: "ffmpeg",
          streamIndex: 0,
          channels: 1,
          sampleRate: 48000,
          threads: 1,
          maxDuration: longSeconds + 1,
          maxTempBytes: 4 * 1024 ** 3,
          declaredDuration: longSeconds,
          neural: true,
          strength: 1,
        }),
      ],
      { measure: true, onChunk: () => {}, timeoutMs: 3600000 },
    );
    const digest = async (file) => {
      const { createReadStream } = await import("node:fs");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      return hash.digest("hex");
    };
    if ((await digest(longReference)) !== (await digest(streamingRaw)))
      throw Error(
        "Long streaming inference differs from whole-buffer reference.",
      );
    repeated = [];
    for (let i = 0; i < 20; i++) {
      const result = await denoise(
        resolve("demo/sample.wav"),
        join(dir, "repeat.wav"),
        { overwrite: true, tempDirectory: dir },
      );
      repeated.push({
        wallMs: result.metrics.wallMs,
        treeRss: result.metrics.sampledPeakTreeRssBytes,
      });
    }
    longFile = {
      seconds: longSeconds,
      frames: long.analysis.frames,
      metrics: long.metrics,
      streamingInference: streamingLong.metrics,
      wholeBufferInference: referenceLong.metrics,
      identicalInferenceOutputSha256: await digest(streamingRaw),
    };
  }
  const leftovers = (await readdir(dir)).filter(
    (name) =>
      name.startsWith("loudness-audio-") || name.startsWith(".loudness-audio-"),
  );
  if (leftovers.length) throw Error("Temporary processing files remain.");
  const evidence = {
    date: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    modelSha256:
      "b758c49d6708a5b7979e3de185705a8a4915076c862fb17b1b304d9a72b75cdc",
    compensatedDelaySamples: 1536,
    quality,
    longFile,
    repeated,
    leftovers,
    limitations: [
      "Two English CC-BY-4.0 narration excerpts with seeded added white noise; this is not a general speech-quality study.",
      "Native afftdn uses a different algorithm; its quality metric is transport-aligned and speed alone is not a like-for-like quality claim.",
      "RSS is sampled every 100 ms, not a hard allocator ceiling; temporary audio uses bounded RAM plus disk proportional to duration.",
      "Streaming inference includes decoder I/O; the whole-buffer inference baseline receives predecoded PCM. End-to-end kit also exports and verifies its result.",
    ],
  };
  await writeFile(
    "artifacts/processing-evidence.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await rm(dir, { recursive: true, force: true });
}

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const kit = require("../dist/cjs/index.js");
const { run } = require("../dist/cjs/process.js");
const { writeWav, noise } = require("./fixtures.cjs");
let dir, input, silence;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-processing-test-"));
  input = await writeWav(path.join(dir, "recording.wav"), { seconds: 2.003 });
  silence = await writeWav(path.join(dir, "silence.wav"), {
    seconds: 1,
    sample: () => 0,
  });
});
after(async () => fs.rm(dir, { recursive: true, force: true }));
const output = (name) => path.join(dir, name);
const clean = async () =>
  assert.deepEqual(
    (await fs.readdir(dir)).filter(
      (name) =>
        name.startsWith("loudness-audio-") ||
        name.startsWith(".loudness-audio-"),
    ),
    [],
  );
test("local denoise produces complete audio with frame delay compensated", async () => {
  const result = await kit.denoise(input, output("denoised.wav"), {
    tempDirectory: dir,
  });
  assert.equal(result.kind, "processing");
  assert.equal(result.analysis.frames, 96144);
  assert.equal(result.output.sampleRate, 48000);
  assert.equal(result.settings.normalized, false);
  if (process.platform !== "win32")
    assert.ok(result.metrics.sampledPeakTreeRssBytes > 0);
  else assert.equal(result.metrics.sampledPeakTreeRssBytes, null);
  await clean();
});
test("enhance executes local speech cleanup and measured normalization", async () => {
  const result = await kit.enhance(
    "examples/fixtures/narration-a.ogg",
    output("speech-enhanced.wav"),
    { tempDirectory: dir, targetLufs: -18, truePeakDbtp: -2 },
  );
  assert.equal(result.settings.voiceProcessing, true);
  assert.equal(result.settings.normalized, true);
  assert.ok(Math.abs(result.analysis.integratedLufs + 18) <= 0.5);
  assert.ok(result.analysis.truePeakDbtp <= -1.8);
  assert.ok(Math.abs(result.output.durationSeconds - 14.84) < 0.002);
  await clean();
});
test("short final frames, including sub-frame clips, are never truncated", async () => {
  for (const frames of [1, 77, 511, 512, 513, 1025]) {
    const file = await writeWav(output(`short-${frames}.wav`), { frames });
    const result = await kit.denoise(file, output(`short-${frames}-out.wav`), {
      tempDirectory: dir,
    });
    assert.equal(result.analysis.frames, frames);
  }
});
test("a slow scratch open cannot discard a fast decoder's complete output", async () => {
  for (const frames of [1, 513]) {
    const source = await writeWav(output(`slow-open-${frames}.wav`), {
      frames,
    });
    const raw = output(`slow-open-${frames}.f32`);
    const hook = output(`slow-open-${frames}.cjs`);
    await fs.writeFile(
      hook,
      `const fs = require('node:fs/promises'); const original = fs.open;
fs.open = async (...args) => {
  if (args[0] === ${JSON.stringify(raw)}) await new Promise(resolve => setTimeout(resolve, 500));
  return original(...args);
};\n`,
    );
    const decoded = await run(process.execPath, [
      "--require",
      hook,
      path.resolve("dist/cjs/processing-worker.js"),
      JSON.stringify({
        input: source,
        output: raw,
        ffmpeg: "ffmpeg",
        streamIndex: 0,
        channels: 1,
        sampleRate: 48000,
        threads: 1,
        maxDuration: 10,
        maxTempBytes: 1048576,
        declaredDuration: frames / 48000,
        neural: false,
        strength: 0,
      }),
    ]);
    const events = decoded.stdout.toString().trim().split("\n").map(JSON.parse);
    assert.equal(
      events.find((event) => event.kind === "worker-result").frames,
      frames,
    );
    assert.equal((await fs.stat(raw)).size, frames * 4);
  }
});
test("stereo has independent channel state and original rate is retained", async () => {
  const file = await writeWav(output("stereo.wav"), {
    sampleRate: 44100,
    channels: 2,
    seconds: 1,
    sample: (i, c) => (c ? 0 : 0.1 * Math.sin((2 * Math.PI * 200 * i) / 44100)),
  });
  const result = await kit.denoise(file, output("stereo-clean.wav"));
  assert.equal(result.output.channels, 2);
  assert.equal(result.output.sampleRate, 44100);
  assert.equal(result.analysis.frames, 44100);
  assert.equal(result.analysis.channels[1].rmsDbfs, null);
});
test("zero strength provides exact PCM bypass without model initialization", async () => {
  const result = await kit.denoise(input, output("bypass.wav"), {
    strength: 0,
    modelDir: output("missing-model"),
  });
  const converted = await kit.convert(input, output("converted.wav"));
  assert.equal(
    result.analysis.decodedPcmSha256,
    converted.analysis.decodedPcmSha256,
  );
});
test("normalization reports silent input rather than fabricating a loudness target", async () => {
  const result = await kit.normalize(silence, output("silent-normal.wav"));
  assert.equal(result.analysis.integratedLufs, null);
  assert.equal(result.settings.normalized, false);
  assert.ok(result.warnings.some((w) => w.includes("skipped")));
});
test("all documented export formats round trip with decoded validation", async () => {
  for (const format of ["wav", "flac", "mp3", "opus"]) {
    const result = await kit.convert(input, output(`export.${format}`), {
      format,
      bitDepth: 24,
    });
    assert.equal(result.output.format, format);
    assert.ok(Math.abs(result.output.durationSeconds - 2.003) < 0.06);
    assert.equal(result.output.channels, 1);
  }
});
test("processing limits and invalid options reject before committing audio", async () => {
  for (const [options, code] of [
    [{ maxFileBytes: 1 }, "FILE_LIMIT"],
    [{ maxDurationSeconds: 0.5 }, "DURATION_LIMIT"],
    [{ strength: 1.1 }, "CONFIG_INVALID"],
    [{ memoryBudgetMiB: -1 }, "CONFIG_INVALID"],
    [{ targetLufs: -2 }, "CONFIG_INVALID"],
    [{ channels: 0 }, "CONFIG_INVALID"],
  ])
    await assert.rejects(kit.denoise(input, output("invalid.wav"), options), {
      code,
    });
  assert.equal(await fs.stat(output("invalid.wav")).catch(() => null), null);
});
test("temporary-disk and native memory budgets stop actual work and clean up", async () => {
  await assert.rejects(
    kit.denoise(input, output("disk-limit.wav"), {
      maxTempBytes: 1024,
      tempDirectory: dir,
    }),
    { code: "TEMP_LIMIT" },
  );
  if (process.platform !== "win32")
    await assert.rejects(
      kit.denoise(input, output("memory-limit.wav"), {
        memoryBudgetMiB: 32,
        tempDirectory: dir,
      }),
      { code: "MEMORY_LIMIT" },
    );
  await clean();
});
test("abort during initialization, inference, normalization and export publishes nothing", async () => {
  for (const phase of [
    "initialize",
    "denoise",
    "normalize",
    "export",
    "verify",
  ]) {
    const controller = new AbortController();
    const target = output(`cancel-${phase}.wav`);
    await assert.rejects(
      kit.enhance(input, target, {
        signal: controller.signal,
        tempDirectory: dir,
        onProgress: (p) => {
          if (p.phase === phase) controller.abort();
        },
      }),
      { code: "CANCELLED" },
      `Cancellation during ${phase} must reject before publication`,
    );
    assert.equal(await fs.stat(target).catch(() => null), null);
    await clean();
  }
});
test("sub-frame processing reports its phase and cancellation preserves existing output", async () => {
  const short = await writeWav(output("short-cancel.wav"), { frames: 1 });
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const [method, phase] of [
      ["denoise", "denoise"],
      ["convert", "decode"],
    ]) {
      const target = output(`short-cancel-${method}-${attempt}-out.wav`);
      const original = Buffer.from(
        "existing destination must survive cancellation",
      );
      await fs.writeFile(target, original);
      const controller = new AbortController();
      let observed = false;
      await assert.rejects(
        kit[method](short, target, {
          overwrite: true,
          signal: controller.signal,
          tempDirectory: dir,
          onProgress: (p) => {
            if (p.phase === phase) {
              observed = true;
              controller.abort();
            }
          },
        }),
        { code: "CANCELLED" },
      );
      assert.equal(observed, true);
      assert.deepEqual(await fs.readFile(target), original);
      await clean();
    }
  }
});
test("observer throws and rejected promises do not interrupt successful processing", async () => {
  const result = await kit.convert(input, output("observer.wav"), {
    onProgress: () => Promise.reject(new Error("observer")),
  });
  assert.equal(result.analysis.frames, 96144);
});
test("source and existing destination are protected including hard-link aliases", async () => {
  await assert.rejects(kit.denoise(input, input, { overwrite: true }), {
    code: "OUTPUT_CLOBBER",
  });
  const alias = output("source-alias.wav");
  await fs.link(input, alias);
  await assert.rejects(kit.denoise(input, alias, { overwrite: true }), {
    code: "OUTPUT_CLOBBER",
  });
  const destination = output("existing.wav");
  await fs.writeFile(destination, "original");
  await assert.rejects(kit.convert(input, destination), {
    code: "OUTPUT_EXISTS",
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    kit.convert(input, destination, {
      overwrite: true,
      signal: controller.signal,
    }),
    { code: "CANCELLED" },
  );
  assert.equal(await fs.readFile(destination, "utf8"), "original");
});
test("model tampering is rejected and cannot silently fall back to filtering", async () => {
  const model = output("bad-model");
  await fs.mkdir(model);
  for (const name of ["initial_states.bin", "initial_states.json", "meta.json"])
    await fs.copyFile(
      path.join("models/dfn3-512-v1", name),
      path.join(model, name),
    );
  await fs.writeFile(path.join(model, "denoiser_model.onnx"), "tampered");
  await assert.rejects(
    kit.denoise(input, output("bad-model-out.wav"), {
      modelDir: model,
      tempDirectory: dir,
    }),
    { code: "MODEL_INVALID" },
  );
  await clean();
});
test("shared client supports more than two jobs with bounded admission and close", async () => {
  const states = [];
  const client = kit.createAudioClient({
    concurrency: 4,
    memoryBudgetMiB: 256,
    totalMemoryBudgetMiB: 1024,
    tempDirectory: dir,
    onState: (s) => states.push(s),
  });
  const controller = new AbortController();
  const work = Array.from({ length: 6 }, (_, i) =>
    client
      .denoise(input, output(`pool-${i}.wav`), { signal: controller.signal })
      .catch((e) => e),
  );
  setTimeout(() => controller.abort(), 100);
  const results = await Promise.all(work);
  await client.close();
  assert.ok(results.every((r) => r.code === "CANCELLED"));
  assert.ok(states.filter((s) => s.state === "running").length >= 4);
  assert.deepEqual(client.state, { active: 0, queued: 0, closed: true });
  assert.throws(
    () => kit.createAudioClient({ concurrency: 8, totalMemoryBudgetMiB: 512 }),
    { code: "CONFIG_INVALID" },
  );
  await clean();
});
test("ordered processing batches reject destination collisions and retain completed results", async () => {
  await assert.rejects(
    kit.processBatch([
      { input, output: output("same.wav") },
      { input, output: output("same.wav") },
    ]),
    { code: "OUTPUT_COLLISION" },
  );
  const result = await kit.processBatch(
    [
      { input, output: output("batch1.wav"), mode: "convert" },
      { input, output: output("batch2.flac"), mode: "convert" },
    ],
    { concurrency: 2, totalMemoryBudgetMiB: 1024 },
  );
  assert.deepEqual(
    result.results.map((r) => r.state),
    ["completed", "completed"],
  );
  assert.deepEqual(
    result.results.map((r) => r.index),
    [0, 1],
  );
});
test("SDK timeout and CLI SIGINT both stop work without partial output", async () => {
  await assert.rejects(
    kit.denoise(input, output("timeout.wav"), {
      timeoutMs: 100,
      tempDirectory: dir,
    }),
    { code: "TIMEOUT" },
  );
  if (process.platform === "win32") return; // Windows does not deliver POSIX SIGINT to a child.
  const child = spawn(
    process.execPath,
    [
      "dist/cjs/cli.js",
      "denoise",
      input,
      "--output",
      output("cli-cancel.wav"),
      "--temp-dir",
      dir,
      "--progress",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let cancelled = false;
  child.stderr.on("data", (bytes) => {
    if (!cancelled && bytes.toString().includes("initialize")) {
      cancelled = true;
      child.kill("SIGINT");
    }
  });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 130);
  assert.equal(await fs.stat(output("cli-cancel.wav")).catch(() => null), null);
  await clean();
});
test("processing doctor exercises installed model and reports missing assets", async () => {
  assert.equal((await kit.processingDoctor()).ready, true);
  const result = await kit.processingDoctor({ modelDir: output("no-assets") });
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((e) => e.includes("MODEL_MISSING")));
});
test("processing batches honor individual job cancellation without cancelling other jobs", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await kit.processBatch(
    [
      {
        input,
        output: output("individual-cancel.wav"),
        options: { signal: controller.signal },
      },
      { input, output: output("individual-success.wav"), mode: "convert" },
    ],
    { concurrency: 2, totalMemoryBudgetMiB: 1024 },
  );
  assert.deepEqual(
    result.results.map((r) => r.state),
    ["cancelled", "completed"],
  );
  assert.equal(
    await fs.stat(output("individual-cancel.wav")).catch(() => null),
    null,
  );
});

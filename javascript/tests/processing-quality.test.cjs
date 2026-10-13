const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { denoise } = require("../dist/cjs/index.js");
const { run } = require("../dist/cjs/process.js");
const { wav, noise } = require("./fixtures.cjs");
test("denoised speech is aligned, improves seeded noise, and retains speech at the end", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-quality-"));
  try {
    const bytes = (
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          "examples/fixtures/narration-a.ogg",
          "-ar",
          "48000",
          "-ac",
          "1",
          "-f",
          "f32le",
          "pipe:1",
        ],
        { maxStdoutBytes: 4 * 1024 * 1024 },
      )
    ).stdout;
    const clean = Float32Array.from({ length: bytes.length / 4 }, (_, i) =>
      bytes.readFloatLE(i * 4),
    );
    const rms = Math.sqrt(
        clean.reduce((sum, v) => sum + v * v, 0) / clean.length,
      ),
      random = noise(99);
    const noisy = Float32Array.from(
      clean,
      (v) => v + (random() * rms) / 0.08660254037844386 / Math.sqrt(10),
    );
    const input = path.join(dir, "noisy.wav"),
      output = path.join(dir, "clean.wav");
    await fs.writeFile(
      input,
      wav({ frames: clean.length, sample: (i) => noisy[i] }),
    );
    await denoise(input, output);
    const out = (
      await run(
        "ffmpeg",
        ["-v", "error", "-i", output, "-f", "f32le", "pipe:1"],
        { maxStdoutBytes: 4 * 1024 * 1024 },
      )
    ).stdout;
    assert.equal(out.length, bytes.length);
    const actual = Float32Array.from(clean, (_, i) => out.readFloatLE(i * 4));
    let dot = 0,
      energy = 0;
    for (let i = 0; i < clean.length; i++) {
      dot += clean[i] * actual[i];
      energy += clean[i] ** 2;
    }
    const scale = dot / energy;
    let residual = 0;
    for (let i = 0; i < clean.length; i++)
      residual += (actual[i] - scale * clean[i]) ** 2;
    const siSdr = 10 * Math.log10((scale * scale * energy) / residual);
    assert.ok(siSdr > 16, `Unaligned or damaged speech: SI-SDR ${siSdr}`);
    let tailEnergy = 0;
    for (let i = clean.length - 4800; i < clean.length; i++)
      tailEnergy += actual[i] ** 2;
    assert.ok(tailEnergy > 0.001, "The final speech samples were not flushed.");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

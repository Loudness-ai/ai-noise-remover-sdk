const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const kit = require("../dist/cjs/index.js");
const { Scanner } = require("../dist/cjs/analysis.js");
const { run } = require("../dist/cjs/process.js");
const { writeWav, noise } = require("./fixtures.cjs");
let dir, tone, silent;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
  tone = await writeWav(path.join(dir, "tone.wav"), { seconds: 12 });
  silent = await writeWav(path.join(dir, "silent.wav"), { sample: () => 0 });
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const close = (a, b, t = 0.02) =>
  assert.ok(Math.abs(a - b) <= t, `${a} differs from ${b}`);
test("native dependency diagnostics", async () =>
  assert.equal((await kit.doctor()).ready, true));
test("calibrated tone: decoded frames, peak, RMS and gated loudness", async () => {
  const a = await kit.analyze(tone);
  assert.equal(a.frames, 576000);
  close(a.samplePeakDbfs, -20, 1e-6);
  close(a.rmsDbfs, -23.0103, 1e-4);
  close(a.integratedLufs, -23, 0.2);
  close(a.truePeakDbtp, -20, 0.1);
  assert.equal(a.state, "measured");
  assert.ok(a.loudnessRangeLu < 0.2);
  assert.equal(a.waveform[0].startSeconds, 0);
  close(a.waveform.at(-1).endSeconds, 12, 1e-8);
});
test("silence never becomes zero LUFS or peak", async () => {
  const a = await kit.analyze(silent);
  assert.equal(a.state, "silent");
  assert.equal(a.integratedLufs, null);
  assert.equal(a.samplePeakDbfs, null);
  assert.equal(a.truePeakDbtp, null);
  close(a.silence.totalSeconds, 2);
  close(a.silence.leadingSeconds, 2);
  close(a.silence.trailingSeconds, 2);
});
test("short and below-gate input have explicit unavailable loudness", async () => {
  const short = await writeWav(path.join(dir, "short.wav"), { seconds: 0.05 });
  const a = await kit.analyze(short);
  assert.equal(a.frames, 2400);
  assert.equal(a.state, "too_short");
  assert.equal(a.integratedLufs, null);
  assert.equal(a.loudnessRangeLu, null);
  const quiet = await writeWav(path.join(dir, "quiet.wav"), {
    sample: (i) => 1e-6 * Math.sin(i),
  });
  assert.equal((await kit.analyze(quiet)).state, "below_loudness_gate");
});
test("stereo correlation, DC and clipping runs", async () => {
  const file = await writeWav(path.join(dir, "stereo.wav"), {
    channels: 2,
    sample: (i, c) => (c === 0 ? 1 : -1),
  });
  const a = await kit.analyze(file);
  assert.equal(a.channels[0].nearFullScaleSamples, 96000);
  assert.equal(a.channels[0].longestNearFullScaleRun, 96000);
  assert.equal(a.channels[0].dcOffset, 1);
  assert.equal(a.stereoCorrelation, null);
  const s = await writeWav(path.join(dir, "inverted.wav"), {
    channels: 2,
    sample: (i, c) => 0.1 * Math.sin(i / 12) * (c ? -1 : 1),
  });
  close((await kit.analyze(s)).stereoCorrelation, -1, 1e-8);
});
test("last samples and block boundaries are exact", () => {
  const data = Buffer.alloc(8 * 17);
  for (let i = 0; i < 17; i++) data.writeDoubleLE(i / 17, i * 8);
  const a = new Scanner(48000, 1),
    b = new Scanner(48000, 1);
  a.consume(data);
  for (let i = 0; i < data.length; i += 7) b.consume(data.subarray(i, i + 7));
  assert.deepEqual(a.finish(), b.finish());
  assert.equal(b.frames, 17);
  const broken = new Scanner(48000, 1);
  broken.consume(Buffer.alloc(3));
  assert.throws(() => broken.finish(), { code: "PCM_TRUNCATED" });
});
test("invalid media, nonfinite PCM and limits reject", async () => {
  const bad = path.join(dir, "bad.wav");
  await fs.writeFile(bad, "bad");
  await assert.rejects(kit.analyze(bad));
  await assert.rejects(kit.analyze("https://example.com/a.wav"), {
    code: "INPUT_INVALID",
  });
  await assert.rejects(kit.analyze(tone, { maxDurationSeconds: 1 }), {
    code: "DURATION_LIMIT",
  });
  await assert.rejects(kit.analyze(tone, { maxFileBytes: 10 }), {
    code: "FILE_LIMIT",
  });
  await assert.rejects(kit.analyze(tone, { maxPoints: 0 }), {
    code: "CONFIG_INVALID",
  });
  const s = new Scanner(48000, 1);
  const v = Buffer.alloc(8);
  v.writeDoubleLE(NaN);
  assert.throws(() => s.consume(v), { code: "PCM_INVALID" });
});
test("quiet intervals, caps and timelines cover whole input", async () => {
  const file = await writeWav(path.join(dir, "quiet-sections.wav"), {
    seconds: 5,
    sample: (i) => (i < 48000 || i >= 192000 ? 0 : 0.1 * Math.sin(i / 20)),
  });
  const a = await kit.analyze(file, { maxPoints: 16, maxEvents: 1 });
  close(a.silence.leadingSeconds, 1);
  close(a.silence.trailingSeconds, 1);
  close(a.silence.totalSeconds, 2);
  assert.equal(a.silence.totalIntervals, 2);
  assert.equal(a.silence.intervals.length, 1);
  assert.ok(a.coverage.eventsCapped);
  assert.ok(a.waveform.length <= 16);
  assert.ok(a.loudnessTimeline.length <= 16);
  close(a.waveform.at(-1).endSeconds, 5);
});
test("policy schema fails fast and unavailable is not a pass", async () => {
  assert.throws(
    () =>
      kit.checkPolicy({
        schemaVersion: 1,
        name: "x",
        rules: [{ metric: "typo", max: 0 }],
      }),
    { code: "POLICY_INVALID" },
  );
  const p = {
    schemaVersion: 1,
    name: "peak",
    rules: [{ metric: "samplePeakDbfs", max: -30 }],
  };
  assert.equal((await kit.validate(tone, p)).failed, true);
  const s = await kit.validate(silent, {
    schemaVersion: 1,
    name: "silence",
    rules: [{ metric: "integratedLufs", max: -14 }],
    unavailable: "fail",
  });
  assert.equal(s.failed, true);
  assert.equal(s.results[0].status, "unavailable");
});
test("source with spaces, Unicode and a leading hyphen", async () => {
  const file = await writeWav(path.join(dir, "- مثال track.wav"), {
    seconds: 0.5,
  });
  assert.equal((await kit.inspect(file)).file.name, "- مثال track.wav");
});
test("before/after identity and duration changes", async () => {
  const c = await kit.compare(tone, tone);
  assert.equal(c.decodedPcmEqual, true);
  const periodic = await writeWav(path.join(dir, "periodic.wav"), {
    seconds: 4,
    sample: (i) => 0.1 * Math.sin((2 * Math.PI * 80 * i) / 48000),
  });
  const p = await kit.compare(periodic, periodic);
  assert.ok(p.alignment.every((w) => w.confidence !== "high"));
  const shorter = await writeWav(path.join(dir, "shorter.wav"), { seconds: 1 });
  const d = await kit.compare(tone, shorter);
  assert.ok(d.findings.some((f) => f.code === "DURATION_CHANGE"));
  assert.equal(d.durationWithinTolerance, false);
});
test("broadband timing and gain are recovered; silent alignment stays unavailable", async () => {
  const random = noise();
  const data = Array.from({ length: 48000 * 4 }, random);
  const a = await writeWav(path.join(dir, "noise.wav"), {
    seconds: 4,
    sample: (i) => data[i],
  });
  const b = await writeWav(path.join(dir, "delay.wav"), {
    seconds: 4,
    sample: (i) => (i >= 4800 ? data[i - 4800] * 0.5 : 0),
  });
  const c = await kit.compare(a, b);
  assert.ok(c.alignment.some((w) => w.confidence === "high"));
  for (const w of c.alignment.filter((w) => w.confidence === "high")) {
    close(w.offsetSeconds, 0.1, 0.005);
    close(w.gainDb, -6.02, 0.15);
  }
  const s = await kit.compare(silent, silent);
  assert.ok(s.alignment.every((w) => w.confidence === "unavailable"));
});
test("batch contains failures and configurable concurrency", async () => {
  const b = await kit.batch([tone, path.join(dir, "missing.wav"), silent], {
    concurrency: 3,
  });
  assert.equal(b.concurrency, 3);
  assert.deepEqual(
    b.results.map((r) => r.state),
    ["completed", "failed", "completed"],
  );
  await assert.rejects(kit.batch([tone, silent], { maxQueued: 1 }), {
    code: "QUEUE_LIMIT",
  });
});
test("offline HTML escapes metadata, includes no scripts and no remote assets", async () => {
  const a = await kit.analyze(tone);
  a.input.file.name = "<script>alert(1)</script>";
  const h = kit.renderHtml(a);
  assert.ok(h.includes("&lt;script&gt;"));
  assert.ok(!h.includes("<script>"));
  assert.ok(!h.includes('src="https://'));
  assert.ok(h.includes("Content-Security-Policy"));
});
test("atomic no-clobber and aborted report preserve previous output", async () => {
  const file = path.join(dir, "report.json");
  await kit.writeAtomic(file, "original");
  await assert.rejects(kit.writeAtomic(file, "new"), { code: "OUTPUT_EXISTS" });
  await assert.rejects(
    kit.writeAtomic(file, "new", {
      overwrite: true,
      signal: AbortSignal.abort(),
    }),
    { code: "CANCELLED" },
  );
  assert.equal(await fs.readFile(file, "utf8"), "original");
  assert.ok(!(await fs.readdir(dir)).some((n) => n.endsWith(".tmp")));
});
test("independent native statistics agree with scanner", async () => {
  const r = await run("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-i",
    tone,
    "-af",
    "astats=reset=0",
    "-f",
    "null",
    "-",
  ]);
  const peak = Number(r.stderr.match(/Peak level dB:\s*([\d.-]+)/)[1]);
  const rms = Number(r.stderr.match(/RMS level dB:\s*([\d.-]+)/)[1]);
  const a = await kit.analyze(tone);
  close(a.samplePeakDbfs, peak, 1e-5);
  close(a.rmsDbfs, rms, 1e-5);
});

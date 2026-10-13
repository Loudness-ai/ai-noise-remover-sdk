const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const kit = require("../dist/cjs/index.js");
const { run } = require("../dist/cjs/process.js");
const { Scanner } = require("../dist/cjs/analysis.js");
const { writeWav, noise } = require("./fixtures.cjs");
let dir, source, sha;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-review-"));
  source = await writeWav(path.join(dir, "original.wav"), { seconds: 4 });
  sha = createHash("sha256")
    .update(await fs.readFile(source))
    .digest("hex");
});
after(async () => fs.rm(dir, { recursive: true, force: true }));
function manifest(args) {
  return {
    schemaVersion: 1,
    fixtures: [{ path: source, sha256: sha, license: "CC0-1.0" }],
    processors: [
      {
        name: "test processor",
        executable: "ffmpeg",
        args,
        version: "test",
        settings: { threads: 1 },
      },
    ],
    repetitions: 1,
    warmup: 0,
    comparison: false,
  };
}
test("a fast truncated processor output fails benchmark coverage even without comparison", async () => {
  const m = manifest([
    "-v",
    "error",
    "-nostdin",
    "-i",
    "{input}",
    "-t",
    "1",
    "-c:a",
    "pcm_s16le",
    "{output}",
  ]);
  const b = await kit.benchmark(m, { allowExecution: true });
  assert.equal(b.runs[0].state, "failed");
  assert.equal(b.runs[0].error.code, "OUTPUT_COVERAGE");
  assert.equal(b.summaries[0].medianMs, null);
  assert.ok(b.runs[0].sampledPeakScratchBytes >= (await fs.stat(source)).size);
  assert.ok(b.runs[0].setupMs >= 0);
  const permitted = await kit.benchmark(
    { ...m, expectations: { allowDurationChange: true } },
    { allowExecution: true },
  );
  assert.equal(permitted.runs[0].state, "completed");
});
test("benchmark rejects colliding fixture names and unbounded manifest run counts", () => {
  const m = manifest(["{input}", "{output}"]);
  assert.throws(
    () =>
      kit.checkManifest({
        ...m,
        fixtures: [
          m.fixtures[0],
          {
            ...m.fixtures[0],
            path: path.join(dir, "elsewhere", "original.wav"),
          },
        ],
      }),
    { code: "MANIFEST_INVALID" },
  );
  assert.throws(
    () => kit.checkManifest({ ...m, repetitions: 1000, warmup: 1 }),
    { code: "MANIFEST_INVALID" },
  );
});
test("benchmark supplies a private input copy and cleans scratch after a failed processor", async () => {
  const before = await fs.readFile(source);
  const scratchBefore = new Set(
    (await fs.readdir(os.tmpdir())).filter((p) =>
      p.startsWith("audio-audit-benchmark-"),
    ),
  );
  const m = manifest(["{input}", "{output}"]);
  m.processors[0].executable = process.execPath;
  m.processors[0].args = [
    "-e",
    'require("node:fs").writeFileSync(process.argv[1],"changed");process.exit(7)',
    "{input}",
    "{output}",
  ];
  const b = await kit.benchmark(m, { allowExecution: true });
  assert.equal(b.runs[0].state, "failed");
  assert.deepEqual(await fs.readFile(source), before);
  const remaining = (await fs.readdir(os.tmpdir())).filter(
    (p) => p.startsWith("audio-audit-benchmark-") && !scratchBefore.has(p),
  );
  assert.deepEqual(remaining, []);
});
test(
  "cancellation terminates an owned child and its stubborn grandchild",
  { skip: process.platform === "win32" },
  async () => {
    const c = new AbortController();
    let pids = [],
      bytes = "";
    const childCode =
      'process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)';
    const parentCode = `process.on('SIGTERM',()=>{});console.log(process.pid);require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
    const timeout = setTimeout(() => c.abort(), 3000);
    try {
      await assert.rejects(
        run(process.execPath, ["-e", parentCode], {
          signal: c.signal,
          onChunk(chunk) {
            bytes += chunk.toString();
            pids = bytes.trim().split(/\s+/).map(Number);
            if (pids.length === 2) c.abort();
          },
        }),
        { code: "CANCELLED" },
      );
      assert.equal(pids.length, 2);
      for (const pid of pids) {
        const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
        }).stdout.trim();
        assert.ok(
          !state || state.startsWith("Z"),
          "owned process still executing",
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  },
);
test("state listeners can cancel during enqueue without losing cancellation", async () => {
  const c = new AbortController(),
    events = [];
  const a = kit.createAuditor({
    onState(e) {
      events.push(e.state);
      if (e.state === "queued") c.abort();
    },
  });
  await assert.rejects(a.analyze(source, { signal: c.signal }), {
    code: "CANCELLED",
  });
  assert.deepEqual(events, ["queued", "cancelled"]);
  await a.close();
  assert.equal(a.state.active, 0);
});
test("queue saturation rejects excess work and close cancels owned active work", async () => {
  const a = kit.createAuditor({ concurrency: 1, maxQueued: 1 });
  const active = a.analyze(source).catch((e) => e.code),
    queued = a.analyze(source).catch((e) => e.code);
  await assert.rejects(a.analyze(source), { code: "QUEUE_LIMIT" });
  await a.close();
  assert.equal(await active, "CANCELLED");
  assert.equal(await queued, "CANCELLED");
  assert.deepEqual(a.state, { active: 0, queued: 0, closed: true });
});
test("CLI validates command-specific options and maps invocation versus I/O failures", () => {
  const cli = path.resolve("dist/cjs/cli.js");
  for (const args of [
    ["analyze", source, "--concurrency", "3"],
    ["doctor", "--html", "out.html"],
    ["--unknown"],
  ]) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(r.status, 3);
    assert.equal(JSON.parse(r.stderr).code, "CONFIG_INVALID");
  }
  const io = spawnSync(
    process.execPath,
    [cli, "analyze", source, "--output", path.join(dir, "missing", "out.json")],
    { encoding: "utf8" },
  );
  assert.equal(io.status, 4);
  assert.equal(JSON.parse(io.stderr).code, "OUTPUT_DIRECTORY");
  const p = spawnSync(
    process.execPath,
    [cli, "validate", source, "--policy", path.resolve("examples/policy.json")],
    { encoding: "utf8" },
  );
  assert.equal(p.status, 2);
  assert.equal(
    spawnSync(process.execPath, [cli, "--version"], {
      encoding: "utf8",
    }).stdout.trim(),
    "1.0.0",
  );
});
test("surround layout is retained; unspecified multichannel weighting is unavailable", async () => {
  const unknown = await writeWav(path.join(dir, "unknown-layout.wav"), {
    seconds: 1,
    channels: 4,
  });
  const a = await kit.analyze(unknown);
  assert.equal(a.channels.length, 4);
  if (a.input.selectedStream.channelLayout === null) {
    assert.equal(a.state, "unknown_channel_layout");
    assert.equal(a.integratedLufs, null);
  }
  const surround = path.join(dir, "surround.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=5.1:sample_rate=48000",
    "-t",
    "1",
    "-c:a",
    "pcm_s24le",
    surround,
  ]);
  const s = await kit.analyze(surround);
  assert.equal(s.channels.length, 6);
  assert.equal(s.input.selectedStream.channelLayout, "5.1");
});
test("finite but unsafe float samples are rejected before aggregate overflow", () => {
  const scanner = new Scanner(48000, 1, {}),
    b = Buffer.alloc(8);
  b.writeDoubleLE(1e308);
  assert.throws(() => scanner.consume(b), { code: "PCM_INVALID" });
});
test("playlist input cannot reference another local recording", async () => {
  const playlist = path.join(dir, "files.ffconcat");
  await fs.writeFile(
    playlist,
    `ffconcat version 1.0\nfile '${source.replaceAll("'", "'\\''")}'\n`,
  );
  await assert.rejects(kit.analyze(playlist), { code: "MEDIA_INVALID" });
});
test("source mutation during decoding invalidates the completed measurement", async () => {
  const file = path.join(dir, "changed.wav");
  await fs.copyFile(source, file);
  let changed = false;
  await assert.rejects(
    kit.analyze(file, {
      onProgress(p) {
        if (p.phase === "decode" && !changed) {
          changed = true;
          require("node:fs").utimesSync(
            file,
            new Date(),
            new Date(Date.now() + 5000),
          );
        }
      },
    }),
    { code: "INPUT_CHANGED" },
  );
  assert.equal(changed, true);
});
test(
  "unreadable permissions and truncated containers fail instead of completing",
  { skip: process.platform === "win32" },
  async () => {
    const unreadable = path.join(dir, "unreadable.wav");
    await fs.copyFile(source, unreadable);
    await fs.chmod(unreadable, 0);
    try {
      if (process.getuid?.() !== 0)
        await assert.rejects(kit.analyze(unreadable), {
          code: "INPUT_UNREADABLE",
        });
    } finally {
      await fs.chmod(unreadable, 0o600);
    }
    const truncated = path.join(dir, "truncated.wav"),
      data = await fs.readFile(source);
    await fs.writeFile(truncated, data.subarray(0, data.length - 101));
    await assert.rejects(kit.analyze(truncated), (e) =>
      ["MEDIA_INVALID", "DECODE_FAILED", "DECODE_INVALID"].includes(e.code),
    );
  },
);
test("policies expose measurement units and analyses remain deterministic", async () => {
  const a = await kit.analyze(source),
    b = await kit.analyze(source);
  assert.deepEqual(a, b);
  const v = kit.evaluate(a, {
    schemaVersion: 1,
    name: "units",
    rules: [
      { metric: "rmsDbfs", max: 0 },
      { metric: "durationSeconds", min: 1 },
    ],
  });
  assert.deepEqual(
    v.results.map((r) => r.unit),
    ["dBFS", "s"],
  );
});
test("dropouts, channel swaps and padding retain factual differences", async () => {
  const original = await writeWav(path.join(dir, "stereo.wav"), {
    seconds: 5,
    channels: 2,
    sample: (i, c) =>
      (c ? 0.2 : 0.1) * Math.sin((2 * Math.PI * (c ? 97 : 59) * i) / 48000),
  });
  const swapped = path.join(dir, "swapped.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    original,
    "-af",
    "pan=stereo|c0=c1|c1=c0",
    "-c:a",
    "pcm_f32le",
    swapped,
  ]);
  const change = await kit.compare(original, swapped);
  assert.equal(change.decodedPcmEqual, false);
  assert.ok(change.differences.channels[0].rmsDb > 5.9);
  const dropped = await writeWav(path.join(dir, "dropout.wav"), {
    seconds: 5,
    channels: 2,
    sample: (i, c) =>
      i >= 48000 && i < 96000
        ? 0
        : (c ? 0.2 : 0.1) * Math.sin((2 * Math.PI * (c ? 97 : 59) * i) / 48000),
  });
  const d = await kit.compare(original, dropped);
  assert.ok(d.differences.quietSeconds >= 0.9);
  const padded = path.join(dir, "padded.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    original,
    "-af",
    "apad=pad_dur=0.2",
    "-c:a",
    "pcm_f32le",
    padded,
  ]);
  const p = await kit.compare(original, padded);
  assert.ok(Math.abs(p.durationDeltaSeconds - 0.2) < 1e-6);
  assert.ok(p.findings.some((f) => f.code === "DURATION_CHANGE"));
});
test("comparison finds controlled late-window timing drift", async () => {
  const random = noise(867);
  let filtered = 0;
  const samples = Float64Array.from({ length: 48000 * 60 }, () => {
    filtered +=
      (1 - Math.exp((-2 * Math.PI * 35) / 48000)) * (random() - filtered);
    return filtered;
  });
  const original = await writeWav(path.join(dir, "clock-source.wav"), {
    seconds: 60,
    sample: (i) => samples[i],
  });
  const drifted = await writeWav(path.join(dir, "clock-drift.wav"), {
    seconds: 60,
    sample: (i) =>
      samples[Math.max(0, Math.round(i - (i / (samples.length - 1)) * 4800))],
  });
  const r = await kit.compare(original, drifted, { toleranceSeconds: 0.02 });
  assert.ok(r.alignment.filter((w) => w.confidence === "high").length >= 2);
  assert.ok(r.driftSeconds > 0.06 && r.driftSeconds < 0.12);
});

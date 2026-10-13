const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { run } = require("../dist/cjs/process.js");
const kit = require("../dist/cjs/index.js");
const { writeWav } = require("./fixtures.cjs");
let dir, source;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-formats-"));
  source = await writeWav(path.join(dir, "source.wav"), { seconds: 1 });
});
after(async () => fs.rm(dir, { recursive: true, force: true }));
for (const [ext, codec] of [
  ["mp3", "libmp3lame"],
  ["flac", "flac"],
  ["m4a", "aac"],
  ["aac", "aac"],
  ["ogg", "vorbis"],
  ["opus", "libopus"],
  ["webm", "libopus"],
])
  test(`decode ${ext}`, async () => {
    const file = path.join(dir, "sample." + ext);
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      source,
      "-c:a",
      codec,
      ...(ext === "ogg" ? ["-strict", "experimental", "-ac", "2"] : []),
      file,
    ]);
    const a = await kit.analyze(file);
    assert.ok(Math.abs(a.durationSeconds - 1) < 0.15);
    assert.ok(a.frames > 0);
  });
test("PCM integer depths and sample rates", async () => {
  for (const [rate, codec] of [
    [8000, "pcm_u8"],
    [16000, "pcm_s16le"],
    [44100, "pcm_s24le"],
    [96000, "pcm_s32le"],
    [192000, "pcm_f64le"],
  ]) {
    const file = path.join(dir, `${rate}.wav`);
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      source,
      "-ar",
      String(rate),
      "-c:a",
      codec,
      file,
    ]);
    const a = await kit.analyze(file);
    assert.equal(a.frames, rate);
    assert.equal(a.input.selectedStream.sampleRate, rate);
  }
});
test("multiple audio streams require explicit choice", async () => {
  const file = path.join(dir, "two.mka");
  await run("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-i",
    source,
    "-i",
    source,
    "-map",
    "0:a",
    "-map",
    "1:a",
    "-c:a",
    "flac",
    file,
  ]);
  await assert.rejects(kit.inspect(file), { code: "STREAM_REQUIRED" });
  const a = await kit.analyze(file, { streamIndex: 1 });
  assert.equal(a.input.selectedStream.index, 1);
});
test("video audio stream is analyzed without rewriting video", async () => {
  const file = path.join(dir, "video.mp4");
  await run("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=size=16x16:rate=1:duration=1",
    "-i",
    source,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "mpeg4",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  const before = (await fs.stat(file)).mtimeMs;
  const a = await kit.analyze(file);
  assert.equal(a.input.selectedStream.index, 1);
  assert.equal((await fs.stat(file)).mtimeMs, before);
});

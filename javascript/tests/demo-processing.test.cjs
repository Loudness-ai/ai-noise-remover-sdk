const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createDemoServer } = require("../demo/server.cjs");
const { analyze } = require("../dist/cjs/index.js");
let app, url, dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-demo-test-"));
  app = createDemoServer({
    concurrency: 2,
    totalMemoryBudgetMiB: 1024,
    tempRoot: dir,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
});
async function request(mode, signal, file = "demo/sample.wav") {
  const form = new FormData();
  form.append(
    "audio",
    new Blob([await fs.readFile(file)]),
    "private-original.wav",
  );
  return fetch(url + "/api/" + mode, {
    method: "POST",
    headers: { "X-Audio-Audit": "1" },
    body: form,
    signal,
  });
}
async function drained() {
  for (let i = 0; i < 200 && app.status().active; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.status().active, 0);
  assert.deepEqual(
    (await fs.readdir(dir)).filter((name) =>
      name.startsWith("audio-audit-demo-"),
    ),
    [],
  );
}
test("demo enhances and denoises with actual WAV responses and no private helper paths", async () => {
  for (const mode of ["denoise", "enhance"]) {
    const response = await request(mode);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    const report = JSON.parse(
      Buffer.from(response.headers.get("x-audio-report"), "base64").toString(),
    );
    assert.equal(report.mode, mode);
    assert.equal(report.durationSeconds, 2);
    assert.ok(!JSON.stringify(report).includes(dir));
    const output = path.join(dir, `${mode}.wav`);
    await fs.writeFile(output, Buffer.from(await response.arrayBuffer()));
    const analysis = await analyze(output);
    assert.equal(analysis.frames, 96000);
    await drained();
  }
});
test("HTTP disconnect aborts inference and removes both input and processed files", async () => {
  const controller = new AbortController();
  const response = request(
    "enhance",
    controller.signal,
    "examples/fixtures/narration-a.ogg",
  );
  while (!app.status().processing)
    await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(response, { name: "AbortError" });
  await drained();
});
test("demo limits are developer configuration, reflected in the browser endpoint", async () => {
  const small = createDemoServer({
    maxFileBytes: 10000,
    maxDurationSeconds: 1,
  });
  await new Promise((resolve) => small.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${small.server.address().port}`;
  try {
    const limits = await (await fetch(base + "/limits")).json();
    assert.deepEqual(limits, { maxFileBytes: 10000, maxDurationSeconds: 1 });
    const form = new FormData();
    form.append(
      "audio",
      new Blob([await fs.readFile("demo/sample.wav")]),
      "audio.wav",
    );
    const response = await fetch(base + "/api/denoise", {
      method: "POST",
      headers: { "X-Audio-Audit": "1" },
      body: form,
    });
    assert.equal(response.status, 413);
  } finally {
    await small.close();
  }
});

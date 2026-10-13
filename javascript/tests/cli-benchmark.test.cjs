const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { run } = require("../dist/cjs/process.js");
const kit = require("../dist/cjs/index.js");
const { writeWav } = require("./fixtures.cjs");
let dir, source;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-cli-"));
  source = await writeWav(path.join(dir, "source.wav"), { seconds: 1 });
});
after(async () => fs.rm(dir, { recursive: true, force: true }));
test("CLI JSON and report rendering work outside cwd", async () => {
  const cli = path.resolve("dist/cjs/cli.js");
  const r = await run(process.execPath, [cli, "analyze", source, "--json"], {
    cwd: dir,
  });
  const a = JSON.parse(r.stdout);
  assert.equal(a.kind, "analysis");
  const json = path.join(dir, "analysis.json");
  await fs.writeFile(json, r.stdout);
  const h = await run(process.execPath, [cli, "report", json], { cwd: dir });
  assert.ok(h.stdout.toString().startsWith("<!doctype html>"));
});
test("CLI refuses to overwrite media and publishes no partial output", async () => {
  const before = await fs.readFile(source);
  await assert.rejects(
    run(process.execPath, [
      path.resolve("dist/cjs/cli.js"),
      "analyze",
      source,
      "--output",
      source,
      "--overwrite",
    ]),
  );
  assert.deepEqual(await fs.readFile(source), before);
});
test("benchmark verifies checksums, explicit execution, output and repetitions", async () => {
  const sha = crypto
    .createHash("sha256")
    .update(await fs.readFile(source))
    .digest("hex");
  const manifest = {
    schemaVersion: 1,
    fixtures: [{ path: source, sha256: sha, license: "CC0-1.0" }],
    processors: [
      {
        name: "PCM copy",
        executable: process.execPath,
        args: [
          "-e",
          'require("node:fs").copyFileSync(process.argv[1],process.argv[2])',
          "{input}",
          "{output}",
        ],
        version: process.version,
        settings: { operation: "copy" },
      },
    ],
    repetitions: 2,
    warmup: 1,
    comparison: false,
  };
  await assert.rejects(kit.benchmark(manifest), { code: "EXECUTION_REQUIRED" });
  await assert.rejects(
    kit.benchmark(
      {
        ...manifest,
        fixtures: [{ ...manifest.fixtures[0], sha256: "0".repeat(64) }],
      },
      { allowExecution: true },
    ),
    { code: "CHECKSUM_MISMATCH" },
  );
  const b = await kit.benchmark(manifest, { allowExecution: true });
  assert.equal(b.runs.length, 2);
  assert.ok(b.runs.every((r) => r.state === "completed"));
  assert.equal(b.summaries[0].p95Ms, null);
  assert.equal(b.manifest.fixtures[0].path, "source.wav");
});
test("shared auditor respects concurrency and emits one terminal event", async () => {
  const events = [];
  const auditor = kit.createAuditor({
    concurrency: 3,
    maxNativeThreads: 3,
    onState: (e) => events.push(e),
  });
  try {
    await Promise.all(Array.from({ length: 9 }, () => auditor.analyze(source)));
    const states = new Map();
    for (const e of events) {
      const l = states.get(e.id) ?? [];
      l.push(e.state);
      states.set(e.id, l);
    }
    assert.equal(states.size, 9);
    for (const s of states.values())
      assert.deepEqual(s, ["queued", "running", "completed"]);
    assert.equal(auditor.state.active, 0);
  } finally {
    await auditor.close();
  }
  await assert.rejects(auditor.analyze(source), { code: "POOL_CLOSED" });
});
test("queued cancellation and close wait for active native work", async () => {
  const auditor = kit.createAuditor({ concurrency: 1 });
  const c = new AbortController();
  const first = auditor.analyze(source);
  const queued = auditor.analyze(source, { signal: c.signal });
  const rejection = assert.rejects(queued, { code: "CANCELLED" });
  c.abort();
  await rejection;
  await first;
  await auditor.close();
  assert.deepEqual(auditor.state, { active: 0, queued: 0, closed: true });
});

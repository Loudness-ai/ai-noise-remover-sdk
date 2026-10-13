const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const kit = require("../dist/cjs/index.js");
const { createDemoServer } = require("../demo/server.cjs");
let dir, fake, pidFile;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-lifecycle-"));
  fake = path.join(dir, "helper");
  pidFile = path.join(dir, "pid");
  if (process.platform !== "win32")
    await fs.writeFile(
      fake,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)\n`,
      { mode: 0o700 },
    );
});
after(() => fs.rm(dir, { recursive: true, force: true }));
async function until(check) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 5000) throw Error("Condition did not complete");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function fixtureForm() {
  const form = new FormData();
  form.append(
    "audio",
    new Blob([await fs.readFile("demo/sample.wav")]),
    "sample.wav",
  );
  return form;
}
test("cancel during decoding and comparison never returns a partial report", async () => {
  for (const method of ["analyze", "compare"]) {
    const c = new AbortController();
    const options = {
      signal: c.signal,
      onProgress(p) {
        if (p.phase === (method === "analyze" ? "decode" : "compare"))
          c.abort();
      },
    };
    const result =
      method === "analyze"
        ? kit.analyze("demo/sample.wav", options)
        : kit.compare("demo/sample.wav", "demo/sample.wav", options);
    await assert.rejects(result, { code: "CANCELLED" });
  }
});
test(
  "queued timeout includes waiting time and produces one terminal failure",
  { skip: process.platform === "win32" },
  async () => {
    const events = [],
      a = kit.createAuditor({
        concurrency: 1,
        ffmpegPath: fake,
        onState: (e) => events.push(e),
      });
    const running = a.analyze("demo/sample.wav").catch((e) => e.code);
    const waiting = a.analyze("demo/sample.wav", { timeoutMs: 30 });
    await assert.rejects(waiting, { code: "TIMEOUT" });
    await a.close();
    assert.equal(await running, "CANCELLED");
    const states = new Map();
    for (const e of events) {
      const list = states.get(e.id) || [];
      list.push(e.state);
      states.set(e.id, list);
    }
    assert.ok(
      [...states.values()].some(
        (list) => JSON.stringify(list) === '["queued","failed"]',
      ),
    );
  },
);
test("pool rejects a job attempting to evade native thread admission", async () => {
  const a = kit.createAuditor({
    concurrency: 3,
    nativeThreads: 1,
    maxNativeThreads: 3,
  });
  await assert.rejects(a.analyze("demo/sample.wav", { nativeThreads: 4 }), {
    code: "CONFIG_INVALID",
  });
  await a.close();
});
test(
  "batch deadline stops active work; fail-fast retains ordered terminal results",
  { skip: process.platform === "win32" },
  async () => {
    await assert.rejects(
      kit.batch(Array(3).fill("demo/sample.wav"), {
        concurrency: 1,
        timeoutMs: 50,
        ffmpegPath: fake,
      }),
      { code: "TIMEOUT" },
    );
    const result = await kit.batch(
      [path.join(dir, "missing.wav"), "demo/sample.wav"],
      { concurrency: 1, failFast: true },
    );
    assert.deepEqual(
      result.results.map((r) => r.state),
      ["failed", "cancelled"],
    );
    const controller = new AbortController();
    const pending = kit.batch(["demo/sample.wav"], {
      signal: controller.signal,
      ffmpegPath: fake,
      onProgress() {
        controller.abort();
      },
    });
    await assert.rejects(pending, { code: "CANCELLED" });
  },
);
test(
  "demo whole-request timeout responds and cleans its private upload",
  { skip: process.platform === "win32" },
  async () => {
    const uploads = path.join(dir, "timeout-uploads");
    await fs.mkdir(uploads);
    const app = createDemoServer({
      tempRoot: uploads,
      ffmpegPath: fake,
      requestTimeoutMs: 150,
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${app.server.address().port}/api/analyze`,
        {
          method: "POST",
          headers: { "X-Audio-Audit": "1" },
          body: await fixtureForm(),
        },
      );
      assert.equal(response.status, 504);
      await until(() => app.status().active === 0);
      assert.deepEqual(await fs.readdir(uploads), []);
    } finally {
      await app.close();
    }
  },
);
test(
  "ten real HTTP disconnects stop native jobs and remove private uploads",
  { skip: process.platform === "win32" },
  async () => {
    const uploads = path.join(dir, "abort-uploads");
    await fs.mkdir(uploads);
    const app = createDemoServer({ tempRoot: uploads, ffmpegPath: fake });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    try {
      for (let i = 0; i < 10; i++) {
        await fs.rm(pidFile, { force: true });
        const c = new AbortController();
        const response = fetch(
          `http://127.0.0.1:${app.server.address().port}/api/analyze`,
          {
            method: "POST",
            headers: { "X-Audio-Audit": "1" },
            body: await fixtureForm(),
            signal: c.signal,
          },
        ).catch((e) => e);
        await until(() =>
          fs.access(pidFile).then(
            () => true,
            () => false,
          ),
        );
        const pid = Number(await fs.readFile(pidFile, "utf8"));
        c.abort();
        await response;
        await until(() => app.status().active === 0);
        assert.deepEqual(await fs.readdir(uploads), []);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
    } finally {
      await app.close();
    }
  },
);
test(
  "CLI SIGINT stops an active inspection helper before exiting 130",
  { skip: process.platform === "win32" },
  async () => {
    await fs.rm(pidFile, { force: true });
    const cli = spawn(
      process.execPath,
      [
        path.resolve("dist/cjs/cli.js"),
        "analyze",
        path.resolve("demo/sample.wav"),
        "--ffprobe",
        fake,
        "--json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    cli.stdout.on("data", (c) => (output += c.toString()));
    cli.stderr.on("data", (c) => (errors += c.toString()));
    const closed = once(cli, "close");
    try {
      await until(() =>
        fs.access(pidFile).then(
          () => true,
          () => false,
        ),
      );
      const pid = Number(await fs.readFile(pidFile, "utf8"));
      cli.kill("SIGINT");
      const [code] = await closed;
      assert.equal(code, 130);
      assert.equal(output, "");
      assert.equal(JSON.parse(errors).code, "CANCELLED");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      if (cli.exitCode === null) cli.kill("SIGKILL");
    }
  },
);

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const Ajv = require("ajv");
const kit = require("../dist/cjs/index.js");
const { createDemoServer } = require("../demo/server.cjs");
let app, url;
before(async () => {
  app = createDemoServer({ concurrency: 3, totalMemoryBudgetMiB: 1536 });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + app.server.address().port;
});
after(async () => app.close());
async function upload(route, fields) {
  const form = new FormData();
  for (const [field, file] of fields)
    form.append(
      field,
      new Blob([await fs.readFile(file)], { type: "audio/wav" }),
      path.basename(file),
    );
  return fetch(url + "/api/" + route, {
    method: "POST",
    headers: { "X-Audio-Audit": "1" },
    body: form,
  });
}
test("demo measures, validates and compares through the package", async () => {
  for (const route of ["analyze", "validate", "compare"]) {
    const fields =
      route === "compare"
        ? [
            ["before", "demo/sample.wav"],
            ["after", "demo/sample.wav"],
          ]
        : [["audio", "demo/sample.wav"]];
    const response = await upload(route, fields);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(
      data.report.kind,
      { analyze: "analysis", validate: "validation", compare: "comparison" }[
        route
      ],
    );
    assert.ok(data.html.includes("Audio Audit report"));
    assert.ok(!JSON.stringify(data.report).includes(os.tmpdir()));
  }
});
test("demo rejects cross-origin and missing required files", async () => {
  const r = await fetch(url + "/api/analyze", { method: "POST", body: "data" });
  assert.equal(r.status, 403);
  const cross = await fetch(url + "/api/analyze", {
    method: "POST",
    headers: { "X-Audio-Audit": "1", Origin: "https://unrelated.invalid" },
    body: "data",
  });
  assert.equal(cross.status, 403);
  const wrong = await upload("compare", [["before", "demo/sample.wav"]]);
  assert.equal(wrong.status, 413);
});
test("malformed demo upload terminates and leaves no active job", async () => {
  const r = await fetch(url + "/api/analyze", {
    method: "POST",
    headers: { "X-Audio-Audit": "1", "Content-Type": "text/plain" },
    body: "not multipart",
  });
  assert.equal(r.status, 422);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(app.status().active, 0);
});
test("public schemas and runtime report shape agree", async () => {
  const a = await kit.analyze("demo/sample.wav");
  const schema = JSON.parse(
    await fs.readFile("schemas/report.schema.json", "utf8"),
  );
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.equal(validate(a), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => kit.checkReport(a));
  const bad = { ...a, channels: [{ samplePeakDbfs: "wrong" }] };
  assert.throws(() => kit.checkReport(bad), { code: "REPORT_INVALID" });
  assert.equal(validate(bad), false);
});
test("report rejects unknown prototype-like properties and nonfinite numbers", async () => {
  const a = await kit.analyze("demo/sample.wav");
  const polluted = JSON.parse(JSON.stringify(a));
  Object.defineProperty(polluted, "constructor", {
    value: "unexpected",
    enumerable: true,
  });
  assert.throws(() => kit.checkReport(polluted), { code: "REPORT_INVALID" });
  assert.throws(() => kit.checkReport({ ...a, rmsDbfs: NaN }), {
    code: "REPORT_INVALID",
  });
});
test("rights-cleared speech fixtures decode and retain credits", async () => {
  const provenance = JSON.parse(
    await fs.readFile("examples/fixtures/provenance.json", "utf8"),
  );
  for (const f of provenance.fixtures) {
    const a = await kit.analyze("examples/fixtures/" + f.file);
    assert.ok(a.frames > 0);
    assert.equal(f.license, "CC-BY-4.0");
    assert.ok(f.recordingCredit);
  }
});

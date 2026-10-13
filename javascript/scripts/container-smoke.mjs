import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [image = "loudness-audio-kit:local", platform = "linux/arm64"] =
  process.argv.slice(2);
const name = "audio-kit-smoke-" + process.pid;
await mkdir("artifacts", { recursive: true });
const docker = (args) => {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (r.status !== 0) throw Error(r.stderr || r.stdout);
  return r.stdout.trim();
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshot = () =>
  JSON.parse(
    docker([
      "exec",
      name,
      "node",
      "-e",
      `const f=require('node:fs');const ids=f.readdirSync('/proc').filter(p=>/^\\d+$/.test(p));const live=p=>{try{return f.readFileSync('/proc/'+p+'/stat','utf8').split(') ')[1][0]!=='Z'}catch{return false}};const active=ids.filter(p=>{try{return f.readFileSync('/proc/'+p+'/comm','utf8').trim()==='ffmpeg'&&live(p)}catch{return false}});const workers=ids.filter(p=>{try{return f.readFileSync('/proc/'+p+'/cmdline','utf8').includes('processing-worker.js')&&p!==String(process.pid)&&live(p)}catch{return false}});console.log(JSON.stringify({uid:process.getuid(),arch:process.arch,node:process.version,nativeProcesses:active.length,inferenceWorkers:workers.length,privateUploads:f.readdirSync('/tmp').filter(x=>x.startsWith('audio-audit-demo-')).length}))`,
    ]),
  );
let receipt,
  started = false;
const scratch = await mkdtemp(join(tmpdir(), "audit-container-smoke-"));
try {
  const fixture = join(scratch, "cancel.flac");
  const generated = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=192000:cl=7.1",
      "-t",
      "300",
      "-c:a",
      "flac",
      fixture,
    ],
    { encoding: "utf8" },
  );
  if (generated.status !== 0)
    throw Error(generated.stderr || "Cancellation fixture generation failed.");
  docker([
    "run",
    "-d",
    "--rm",
    "--platform",
    platform,
    "--name",
    name,
    "-p",
    "127.0.0.1::7860",
    image,
  ]);
  started = true;
  const port = docker(["port", name, "7860/tcp"]).split(":").at(-1);
  const url = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(250);
  }
  if (!ready) throw Error("Container did not become ready.");
  const before = snapshot();
  if (before.uid === 0) throw Error("Demo runs as root.");
  const audio = await readFile("demo/sample.wav");
  const checks = [];
  for (const task of ["denoise", "enhance"]) {
    const body = new FormData();
    body.append("audio", new Blob([audio]), "sample.wav");
    const response = await fetch(url + "/api/" + task, {
      method: "POST",
      headers: { "X-Audio-Audit": "1" },
      body,
    });
    if (
      response.status !== 200 ||
      response.headers.get("content-type") !== "audio/wav"
    )
      throw Error(task + " did not produce audio");
    const bytes = Buffer.from(await response.arrayBuffer());
    const report = JSON.parse(
      Buffer.from(response.headers.get("x-audio-report"), "base64").toString(),
    );
    if (
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      report.durationSeconds !== 2 ||
      JSON.stringify(report).includes("/tmp/")
    )
      throw Error(task + " audio/summary failed");
    checks.push({
      task,
      status: response.status,
      bytes: bytes.length,
      duration: report.durationSeconds,
    });
  }
  for (const task of ["analyze", "validate", "compare"]) {
    const body = new FormData();
    for (const field of task === "compare" ? ["before", "after"] : ["audio"])
      body.append(field, new Blob([audio]), "sample.wav");
    const r = await fetch(url + "/api/" + task, {
      method: "POST",
      headers: { "X-Audio-Audit": "1" },
      body,
    });
    const data = await r.json();
    if (
      r.status !== 200 ||
      !data.report ||
      !data.html.includes("Audio Audit report")
    )
      throw Error(task + " failed");
    checks.push({ task, status: r.status, kind: data.report.kind });
  }
  const c = new AbortController();
  const body = new FormData();
  body.append("audio", new Blob([await readFile(fixture)]), "cancel.flac");
  const request = fetch(url + "/api/enhance", {
    method: "POST",
    headers: { "X-Audio-Audit": "1" },
    body,
    signal: c.signal,
  }).catch((e) => e.name);
  let during;
  for (let i = 0; i < 30; i++) {
    during = snapshot();
    if (during.nativeProcesses > 0) break;
    await delay(50);
  }
  if (!during.nativeProcesses)
    throw Error("No active native decoding observed before cancellation.");
  c.abort();
  await request;
  let after;
  for (let i = 0; i < 40; i++) {
    after = snapshot();
    if (
      !after.nativeProcesses &&
      !after.inferenceWorkers &&
      !after.privateUploads
    )
      break;
    await delay(100);
  }
  if (after.nativeProcesses || after.inferenceWorkers || after.privateUploads)
    throw Error("Cancelled container work survived or retained an upload.");
  receipt = {
    image,
    platform,
    imageId: docker(["inspect", "--format", "{{.Image}}", name]),
    before,
    checks,
    cancellation: { observedNativeProcesses: during.nativeProcesses, after },
    result: "passed",
  };
  await writeFile(
    "artifacts/container-smoke-" + platform.replace("/", "-") + ".json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  try {
    if (started) docker(["stop", "--time", "5", name]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const scratch = await mkdtemp(join(tmpdir(), "audio-kit-consumer-"));
await mkdir("artifacts", { recursive: true });
const expectedPackage = JSON.parse(await readFile("package.json", "utf8"));
const publicReadme = await readFile("README.md", "utf8");
if (
  expectedPackage.name !== "loudness-audio-kit" ||
  expectedPackage.homepage !==
    "https://loudness.ai/developers/ai-noise-remover-sdk/" ||
  !publicReadme.includes("npm install loudness-audio-kit") ||
  /\]\((?!https?:\/\/|#)[^)]+\)/.test(publicReadme)
)
  throw Error(
    "Public package identity or installation documentation is invalid.",
  );
const execute = (command, args, cwd = process.cwd()) => {
  if (command === "npm") {
    if (!process.env.npm_execpath)
      throw Error("Run verification through npm run verify:package.");
    args = [process.env.npm_execpath, ...args];
    command = process.execPath;
  }
  const r = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw Error(r.stdout + r.stderr);
  return r.stdout;
};
try {
  const packed = JSON.parse(
    execute("npm", ["pack", "--json", "--pack-destination", "artifacts"]),
  );
  const manifest = packed[0];
  if (
    manifest.name !== expectedPackage.name ||
    manifest.version !== expectedPackage.version
  )
    throw Error("Packed identity differs from the release manifest.");
  if (
    manifest.files.some((f) =>
      /node_modules|artifacts|\.env|api\/|protected-before|workspace-protected/.test(
        f.path,
      ),
    )
  )
    throw Error("Distribution contains forbidden assets.");
  const models = manifest.files.filter((f) => f.path.startsWith("models/"));
  if (
    models.length !== 4 ||
    models.some(
      (f) =>
        !/^models\/dfn3-512-v1\/(denoiser_model\.onnx|initial_states\.(bin|json)|meta\.json)$/.test(
          f.path,
        ),
    )
  )
    throw Error("Pinned model assets are missing or unexpected.");
  const tar = resolve("artifacts", manifest.filename);
  await writeFile(
    join(scratch, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  execute(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tar],
    scratch,
  );
  await writeFile(
    join(scratch, "consume.mjs"),
    `import {analyze,denoise,processingDoctor} from 'loudness-audio-kit';const d=await processingDoctor();if(!d.ready)throw Error('local processing missing');const r=await denoise(${JSON.stringify(resolve("demo/sample.wav"))},'esm-denoised.wav');if(r.analysis.frames!==96000)throw Error('bad packaged result');console.log('ESM installed local denoiser passed');\n`,
  );
  await writeFile(
    join(scratch, "consume.cjs"),
    `const {enhance}=require('loudness-audio-kit');enhance(${JSON.stringify(resolve("examples/fixtures/narration-a.ogg"))},'cjs-enhanced.wav').then(r=>{if(!r.settings.normalized||Math.abs(r.analysis.integratedLufs+16)>.5)throw Error('bad enhancement');console.log('CommonJS installed local enhancement passed')}).catch(e=>{console.error(e);process.exitCode=1});\n`,
  );
  console.log(execute(process.execPath, ["consume.mjs"], scratch));
  console.log(execute(process.execPath, ["consume.cjs"], scratch));
  const executable = join(
    scratch,
    "node_modules/loudness-audio-kit/dist/cjs/cli.js",
  );
  const installed = join(scratch, "node_modules/loudness-audio-kit");
  const installedPackage = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  if (
    installedPackage.name !== expectedPackage.name ||
    installedPackage.version !== expectedPackage.version ||
    installedPackage.homepage !== expectedPackage.homepage
  )
    throw Error("Installed release metadata does not match the candidate.");
  execute(
    process.execPath,
    [
      join(installed, "examples/process.mjs"),
      resolve("examples/fixtures/narration-a.ogg"),
      join(scratch, "example-enhanced.wav"),
    ],
    scratch,
  );
  execute(
    process.execPath,
    [
      join(installed, "examples/analyze.mjs"),
      resolve("demo/sample.wav"),
      join(scratch, "example.html"),
    ],
    scratch,
  );
  execute(
    process.execPath,
    [join(installed, "examples/commonjs.cjs"), resolve("demo/sample.wav")],
    scratch,
  );
  execute(
    process.execPath,
    [join(installed, "examples/workflows.mjs"), resolve("demo/sample.wav")],
    scratch,
  );
  for (const ext of ["mts", "cts"]) {
    const filename = join(scratch, "typed." + ext);
    await writeFile(
      filename,
      `import { analyze, type Analysis, type Policy } from 'loudness-audio-kit/core';import { renderHtml } from 'loudness-audio-kit/report';import {denoise,type ProcessingResult} from 'loudness-audio-kit/processing';import {createAudioClient,processBatch,type ProcessingBatchResult} from 'loudness-audio-kit';const processed:Promise<ProcessingResult>=denoise('input.wav','output.wav',{strength:.8});const jobs:Promise<ProcessingBatchResult>=processBatch([{input:'a.wav',output:'b.wav',mode:'enhance'}]);void createAudioClient({concurrency:6,totalMemoryBudgetMiB:3072}).close();const task:Promise<Analysis>=analyze('recording.wav');void task.then(renderHtml);\n// @ts-expect-error unknown metric must be rejected\nconst bad:Policy={schemaVersion:1,name:'bad',rules:[{metric:'fake',max:0}]};\n// @ts-expect-error output format must be known\nvoid denoise('a.wav','b.wav',{format:'unknown'});\n`,
    );
    execute(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--types",
        "node",
        "--typeRoots",
        resolve("node_modules/@types"),
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        filename,
      ],
      scratch,
    );
  }
  for (const command of ["denoise", "enhance", "normalize", "convert"]) {
    const output = join(scratch, `${command}-cli.wav`);
    const result = JSON.parse(
      execute(
        process.execPath,
        [
          executable,
          command,
          resolve("examples/fixtures/narration-a.ogg"),
          "--output",
          output,
          "--json",
        ],
        scratch,
      ),
    );
    if (
      result.kind !== "processing" ||
      result.mode !== command ||
      result.output.durationSeconds < 14.8
    )
      throw Error("Installed processing CLI failed: " + command);
  }
  const jobsPath = join(scratch, "jobs.json");
  await writeFile(
    jobsPath,
    JSON.stringify([
      {
        input: resolve("demo/sample.wav"),
        output: "batch-clean.wav",
        mode: "denoise",
      },
      {
        input: resolve("demo/sample.wav"),
        output: "batch-converted.flac",
        mode: "convert",
      },
    ]),
  );
  const jobs = JSON.parse(
    execute(
      process.execPath,
      [
        executable,
        "process-batch",
        jobsPath,
        "--concurrency",
        "2",
        "--total-memory-mib",
        "1024",
        "--json",
      ],
      scratch,
    ),
  );
  if (jobs.results.some((r) => r.state !== "completed"))
    throw Error("Installed batch CLI failed.");
  const ready = JSON.parse(
    execute(
      process.execPath,
      [executable, "processing-doctor", "--json"],
      scratch,
    ),
  );
  if (!ready.ready || ready.speechEngine !== "ready")
    throw Error("Installed speech doctor failed.");
  for (const [command, files] of [
    ["doctor", []],
    ["inspect", [resolve("demo/sample.wav")]],
    [
      "validate",
      [
        resolve("demo/sample.wav"),
        "--policy",
        join(installed, "examples/policy.json"),
      ],
    ],
    ["compare", [resolve("demo/sample.wav"), resolve("demo/sample.wav")]],
    [
      "batch",
      [
        resolve("demo/sample.wav"),
        resolve("demo/sample.wav"),
        "--concurrency",
        "3",
      ],
    ],
  ]) {
    const args = [executable, command, ...files, "--json"];
    const r = spawnSync(process.execPath, args, {
      cwd: scratch,
      encoding: "utf8",
    });
    if (r.status !== (command === "validate" ? 2 : 0))
      throw Error(command + " installed workflow failed: " + r.stderr);
    JSON.parse(r.stdout);
  }
  const json = JSON.parse(
    execute(
      process.execPath,
      [executable, "analyze", resolve("demo/sample.wav"), "--json"],
      scratch,
    ),
  );
  if (json.frames !== 96000) throw Error("Installed CLI failed.");
  const reportInput = join(scratch, "analysis.json");
  await writeFile(reportInput, JSON.stringify(json));
  execute(
    process.execPath,
    [executable, "report", reportInput, "--html", join(scratch, "report.html")],
    scratch,
  );
  if (!(await readFile(join(scratch, "report.html"), "utf8")).includes("96000"))
    throw Error("Installed report command failed.");
  const dependency = JSON.parse(
    execute(process.execPath, [executable, "doctor", "--json"], scratch),
  );
  const fixture = resolve("demo/sample.wav");
  const benchmarkConfig = join(scratch, "benchmark.json");
  await writeFile(
    benchmarkConfig,
    JSON.stringify({
      schemaVersion: 1,
      fixtures: [
        {
          path: fixture,
          sha256: createHash("sha256")
            .update(await readFile(fixture))
            .digest("hex"),
          license: "CC0-1.0",
        },
      ],
      processors: [
        {
          name: "PCM copy",
          executable: "ffmpeg",
          args: [
            "-nostdin",
            "-v",
            "error",
            "-i",
            "{input}",
            "-c:a",
            "pcm_s16le",
            "{output}",
          ],
          version: dependency.versions.ffmpeg,
          settings: { codec: "pcm_s16le" },
        },
      ],
      repetitions: 1,
      warmup: 0,
      comparison: true,
    }),
  );
  const measured = JSON.parse(
    execute(
      process.execPath,
      [executable, "benchmark", benchmarkConfig, "--execute", "--json"],
      scratch,
    ),
  );
  if (measured.runs.length !== 1 || measured.runs[0].state !== "completed")
    throw Error("Installed benchmark command failed.");
  const digest = createHash("sha256")
    .update(await readFile(tar))
    .digest("hex");
  await writeFile(
    "artifacts/package-receipt.json",
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        filename: manifest.filename,
        sha256: digest,
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        unpackedBytes: manifest.unpackedSize,
        files: manifest.files,
        checks: [
          "installed ESM",
          "installed CommonJS",
          "installed CLI",
          "installed ESM/CommonJS subpath types",
          "installed documentation examples and all CLI workflows",
          "installed denoise/enhance/normalize/convert and processing batch",
          "installed pinned model checksum and real inference",
          "allowlisted contents",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Packaged consumer checks passed. SHA-256:", digest);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

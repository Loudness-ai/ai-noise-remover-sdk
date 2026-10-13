import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const dir = await mkdtemp(join(tmpdir(), "audio-audit-types-"));
try {
  for (const ext of ["mts", "cts"]) {
    await writeFile(
      join(dir, "consumer." + ext),
      `import { analyze, createAuditor, validate, enhance, denoise, createAudioClient, processBatch, type ProcessingResult, type ProcessingBatchResult, type Policy, type Analysis } from ${JSON.stringify(resolve("dist/" + (ext === "mts" ? "esm" : "cjs") + "/index.js").replaceAll("\\", "/"))};\nconst policy:Policy={schemaVersion:1,name:'test',rules:[{metric:'truePeakDbtp',max:-1}]};\nconst operation:Promise<Analysis>=analyze('input.wav');\nconst processed:Promise<ProcessingResult>=enhance('input.wav','out.wav',{strength:.8,targetLufs:-16});const jobs:Promise<ProcessingBatchResult>=processBatch([{input:'input.wav',output:'output.wav',mode:'denoise'}]);void createAudioClient({concurrency:6,totalMemoryBudgetMiB:3072}).close();void validate('input.wav',policy);void createAuditor({concurrency:4}).close();\n// @ts-expect-error a typo must not pass the public policy type\nconst bad:Policy={schemaVersion:1,name:'bad',rules:[{metric:'unknown',max:0}]};\n// @ts-expect-error unknown output format must fail\nvoid denoise('in.wav','out.wav',{format:'aac'});\n`,
    );
    const r = spawnSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
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
        join(dir, "consumer." + ext),
      ],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw Error("Consumer declarations failed.");
  }
  console.log("ESM and CommonJS strict TypeScript consumers passed.");
} finally {
  await rm(dir, { recursive: true, force: true });
}

import { spawnSync } from "node:child_process";
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
const compiler = "node_modules/typescript/bin/tsc";
for (const args of [[], ["--module", "ES2022", "--outDir", "dist/esm"]]) {
  const r = spawnSync(
    process.execPath,
    [compiler, "-p", "tsconfig.json", ...args],
    { stdio: "inherit" },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}
await mkdir("dist/esm", { recursive: true });
await writeFile("dist/esm/package.json", '{"type":"module"}\n');
const processing = "dist/esm/processing.js";
await writeFile(
  processing,
  'import { fileURLToPath as moduleFilePath } from "node:url";\nconst __dirname = moduleFilePath(new URL(".", import.meta.url));\n' +
    (await readFile(processing, "utf8")),
);
await chmod("dist/cjs/cli.js", 0o755).catch((e) => {
  if (e.code !== "ENOENT") throw e;
});

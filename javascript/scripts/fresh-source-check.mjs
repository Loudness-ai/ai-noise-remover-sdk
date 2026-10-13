import {
  mkdtemp,
  cp,
  rm,
  mkdir,
  writeFile,
  readdir,
  readFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const folder = await mkdtemp(join(tmpdir(), "audio-kit-source-"));
const allowed = [
  "src",
  "models",
  "schemas",
  "docs",
  "scripts",
  "tests",
  "examples",
  "demo",
  ".github",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "README.md",
  "LICENSE",
  "DISTRIBUTION-LICENSE",
  "NOTICE",
  "third-party",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  ".gitignore",
  ".dockerignore",
];
const commands = [
  ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  ["ci", "--prefix", "demo", "--ignore-scripts", "--no-audit", "--no-fund"],
  ["test"],
  ["run", "test:types"],
  ["run", "check:schemas"],
  ["run", "verify:package"],
  ["run", "lint"],
];
let log = "",
  checks = [];
let completed = false,
  sourceSha256;
await mkdir("artifacts", { recursive: true });
try {
  for (const path of allowed)
    await cp(path, join(folder, path), {
      recursive: true,
      filter: (p) =>
        !p
          .split(/[\\/]/)
          .some((part) =>
            ["node_modules", "artifacts", ".DS_Store"].includes(part),
          ),
    });
  const hashes = [];
  async function inventory(path) {
    const absolute = join(folder, path);
    const { stat } = await import("node:fs/promises");
    if ((await stat(absolute)).isDirectory()) {
      for (const name of await readdir(absolute))
        await inventory(join(path, name));
    } else
      hashes.push([
        path.split("\\").join("/"),
        createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      ]);
  }
  for (const path of allowed) await inventory(path);
  sourceSha256 = createHash("sha256")
    .update(
      hashes
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([path, hash]) => path + "\0" + hash + "\n")
        .join(""),
    )
    .digest("hex");
  if (!process.env.npm_execpath) throw Error("Run with npm run verify:source.");
  for (const args of commands) {
    const r = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: folder,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    log += "$ npm " + args.join(" ") + "\n" + r.stdout + r.stderr + "\n";
    checks.push({ command: ["npm", ...args], exitCode: r.status });
    if (r.status !== 0)
      throw Error("Fresh source command failed: " + args.join(" "));
  }
  completed = true;
  console.log("Fresh standalone source installation and verification passed.");
} finally {
  await writeFile("artifacts/fresh-source-verification.log", log);
  try {
    await rm(folder, { recursive: true, force: true });
  } catch (e) {
    completed = false;
    throw e;
  } finally {
    await writeFile(
      "artifacts/fresh-source-verification.json",
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          isolatedTemporaryDirectory: true,
          websiteCheckoutImports: false,
          sourceSha256,
          checks,
          result: completed ? "passed" : "failed",
        },
        null,
        2,
      ) + "\n",
    );
  }
}

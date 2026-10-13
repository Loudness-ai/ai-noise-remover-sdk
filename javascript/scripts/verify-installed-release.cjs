const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
async function main() {
  const [
    tarball = "artifacts/loudness-audio-kit-1.0.0.tgz",
    receipt = "artifacts/installed-release.json",
  ] = process.argv.slice(2);
  const candidate = path.resolve(tarball);
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "audio-kit-installed-"),
  );
  const npmCli =
    process.env.npm_execpath ??
    path.resolve(
      path.dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    );
  const execute = (executable, args) => {
    const result = spawnSync(executable, args, {
      cwd: folder,
      encoding: "utf8",
      maxBuffer: 4 * 1024 ** 2,
    });
    if (result.status !== 0) throw Error(result.stdout + result.stderr);
    return result.stdout;
  };
  try {
    await fs.writeFile(
      path.join(folder, "package.json"),
      '{"private":true,"type":"module"}\n',
    );
    execute(process.execPath, [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      candidate,
    ]);
    const installed = path.join(folder, "node_modules/loudness-audio-kit");
    const kit = require(path.join(installed, "dist/cjs/index.js"));
    const esm = await import(
      pathToFileURL(path.join(installed, "dist/esm/index.js")).href
    );
    const input = path.join(installed, "examples/fixtures/narration-a.ogg");
    const checks = [];
    for (const [name, module] of [
      ["cjs-denoise", kit],
      ["esm-enhance", esm],
    ]) {
      const mode = name.endsWith("denoise") ? "denoise" : "enhance";
      const result = await module[mode](
        input,
        path.join(folder, name + ".wav"),
      );
      if (
        result.output.durationSeconds !== 14.84 ||
        result.analysis.frames !== 327222
      )
        throw Error("Installed SDK truncated audio.");
      checks.push({
        name,
        frames: result.analysis.frames,
        duration: result.output.durationSeconds,
      });
    }
    const cli = path.join(installed, "dist/cjs/cli.js");
    for (const mode of ["denoise", "enhance", "normalize", "convert"]) {
      const result = JSON.parse(
        execute(process.execPath, [
          cli,
          mode,
          input,
          "--output",
          path.join(folder, mode + ".flac"),
          "--json",
        ]),
      );
      if (result.mode !== mode || result.output.durationSeconds !== 14.84)
        throw Error("Installed CLI failed.");
      checks.push({
        name: "cli-" + mode,
        frames: result.analysis.frames,
        duration: result.output.durationSeconds,
      });
    }
    const doctor = await kit.processingDoctor();
    if (!doctor.ready) throw Error("Installed speech doctor failed.");
    const report = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sha256: createHash("sha256")
        .update(await fs.readFile(candidate))
        .digest("hex"),
      sourceCheckoutRequired: false,
      checks,
      speechEngine: doctor.speechEngine,
      result: "passed",
    };
    await fs.mkdir(path.dirname(path.resolve(receipt)), { recursive: true });
    await fs.writeFile(receipt, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

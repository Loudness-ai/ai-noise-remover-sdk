const http = require("node:http");
const { readFile, mkdtemp, rm, chmod } = require("node:fs/promises");
const { createWriteStream, createReadStream } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { join, basename } = require("node:path");
const { tmpdir, availableParallelism } = require("node:os");
const Busboy = require("busboy");
const { createAudioClient, renderHtml, examplePolicy, errorInfo } = (() => {
  const kit = require("../dist/cjs/index.js");
  return {
    ...kit,
    errorInfo: (error) =>
      error instanceof kit.AuditError
        ? error.toJSON()
        : {
            code: "PROCESSING_FAILED",
            message: "The audio could not be processed.",
          },
  };
})();
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_DURATION = 300;
const { brandSvg } = require("../dist/cjs/brand-ui.js");
function createDemoServer({
  concurrency,
  maxRequests = 8,
  requestTimeoutMs = 150000,
  processingTimeoutMs = 120000,
  maxFileBytes = MAX_BYTES,
  maxDurationSeconds = MAX_DURATION,
  memoryBudgetMiB = 512,
  totalMemoryBudgetMiB,
  maxTempBytes = 1024 * 1024 * 1024,
  tempRoot = tmpdir(),
  ffmpegPath,
} = {}) {
  for (const value of [
    maxRequests,
    requestTimeoutMs,
    processingTimeoutMs,
    maxFileBytes,
    maxDurationSeconds,
  ])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Invalid demo limit.");
  const auditor = createAudioClient({
    concurrency,
    maxQueued: maxRequests,
    maxDurationSeconds,
    maxFileBytes,
    timeoutMs: processingTimeoutMs,
    memoryBudgetMiB,
    totalMemoryBudgetMiB,
    maxTempBytes,
    ffmpegPath,
  });
  let active = 0;
  const controllers = new Set();
  const rates = new Map();
  function send(res, status, data, type = "application/json") {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(
      typeof data === "string" || Buffer.isBuffer(data)
        ? data
        : JSON.stringify(data),
    );
  }
  async function receive(req, dir, signal, expected) {
    const uploads = [];
    const writes = [];
    let limited = false;
    const parser = Busboy({
      headers: req.headers,
      limits: {
        files: expected,
        fileSize: maxFileBytes,
        fields: 0,
        parts: expected + 1,
        headerPairs: 50,
      },
    });
    parser.on("file", (field, file, info) => {
      if (!["before", "after", "audio"].includes(field)) {
        limited = true;
        file.resume();
        return;
      }
      const location = join(dir, "upload-" + uploads.length);
      const item = {
        field,
        path: location,
        name: basename(info.filename || "recording"),
        bytes: 0,
      };
      uploads.push(item);
      file.on("limit", () => {
        limited = true;
      });
      file.on("data", (chunk) => {
        item.bytes += chunk.length;
      });
      writes.push(
        pipeline(
          file,
          createWriteStream(location, { flags: "wx", mode: 0o600 }),
          { signal },
        ),
      );
      // Attach rejection handling immediately; still propagate it after parser completion.
      writes.at(-1).catch(() => {});
    });
    for (const event of ["filesLimit", "fieldsLimit", "partsLimit"])
      parser.on(event, () => {
        limited = true;
      });
    try {
      let bytes = 0;
      const boundBody = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > maxFileBytes * expected + 65536
              ? Object.assign(new Error("Upload rejected."), {
                  uploadInvalid: true,
                })
              : null,
            chunk,
          );
        },
      });
      await pipeline(req, boundBody, parser, { signal });
      await Promise.all(writes);
    } catch (e) {
      await Promise.allSettled(writes);
      throw e;
    }
    if (
      limited ||
      uploads.length !== expected ||
      uploads.some((u) => !u.bytes) ||
      new Set(uploads.map((u) => u.field)).size !== uploads.length
    )
      throw Object.assign(new Error("Upload rejected."), {
        uploadInvalid: true,
      });
    return uploads;
  }
  const server = http.createServer(async (req, res) => {
    const route = req.url?.split("?")[0];
    if (req.method === "GET") {
      if (route === "/brand.svg")
        return send(res, 200, brandSvg(), "image/svg+xml");
      if (route === "/limits")
        return send(res, 200, { maxFileBytes, maxDurationSeconds });
      const assets = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
        "/sample.wav": ["sample.wav", "audio/wav"],
        "/speech-example.wav": ["speech-example.wav", "audio/wav"],
      };
      if (!assets[route]) return send(res, 404, { error: "Not found." });
      try {
        const [file, type] = assets[route];
        return send(res, 200, await readFile(join(__dirname, file)), type);
      } catch {
        return send(res, 404, { error: "Not found." });
      }
    }
    if (
      req.method !== "POST" ||
      ![
        "/api/analyze",
        "/api/compare",
        "/api/validate",
        "/api/denoise",
        "/api/enhance",
      ].includes(route)
    )
      return send(res, 404, { error: "Not found." });
    // A custom header requires a preflight for cross-origin browser requests; no CORS is enabled.
    if (req.headers["x-audio-audit"] !== "1")
      return send(res, 403, { error: "Request rejected." });
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host)
          return send(res, 403, { error: "Request rejected." });
      } catch {
        return send(res, 403, { error: "Request rejected." });
      }
    }
    const address = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    for (const [key, value] of rates)
      if (now - value.since > 60000) rates.delete(key);
    const rate = rates.get(address) ?? { since: now, count: 0 };
    rate.count++;
    rates.set(address, rate);
    if (rate.count > 30 || rates.size > 2000 || active >= maxRequests)
      return send(res, 429, { error: "Busy. Please try again shortly." });
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxFileBytes * 2 + 65536)
      return send(res, 413, {
        error: "The upload exceeds this demonstration's file-size limit.",
      });
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    let dir;
    try {
      dir = await mkdtemp(join(tempRoot, "audio-audit-demo-"));
      await chmod(dir, 0o700);
      const uploads = await receive(
        req,
        dir,
        controller.signal,
        route === "/api/compare" ? 2 : 1,
      );
      let report;
      if (route === "/api/compare") {
        const before = uploads.find((u) => u.field === "before"),
          after = uploads.find((u) => u.field === "after");
        if (!before || !after)
          throw Object.assign(new Error("Upload rejected."), {
            uploadInvalid: true,
          });
        report = await auditor.compare(before.path, after.path, {
          signal: controller.signal,
        });
        report.before.input.file.name = before.name;
        report.after.input.file.name = after.name;
      } else {
        const upload = uploads.find((u) => u.field === "audio");
        if (!upload)
          throw Object.assign(new Error("Upload rejected."), {
            uploadInvalid: true,
          });
        if (route === "/api/denoise" || route === "/api/enhance") {
          const processed = await auditor.process(
            upload.path,
            join(dir, "processed.wav"),
            route.slice(5),
            { signal: controller.signal, tempDirectory: dir },
          );
          const summary = {
            mode: processed.mode,
            file: "processed.wav",
            durationSeconds: processed.output.durationSeconds,
            sampleRate: processed.output.sampleRate,
            channels: processed.output.channels,
            integratedLufs: processed.analysis.integratedLufs,
            truePeakDbtp: processed.analysis.truePeakDbtp,
            warnings: processed.warnings,
          };
          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Disposition": 'attachment; filename="processed.wav"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Audio-Report": Buffer.from(JSON.stringify(summary)).toString(
              "base64",
            ),
          });
          await pipeline(createReadStream(processed.output.path), res, {
            signal: controller.signal,
          });
          return;
        }
        report =
          route === "/api/validate"
            ? await auditor.validate(upload.path, examplePolicy, {
                signal: controller.signal,
              })
            : await auditor.analyze(upload.path, { signal: controller.signal });
        (report.analysis ?? report).input.file.name = upload.name;
      }
      // Result payload contains measurements and workflow data, never helper paths or logs.
      send(res, 200, { report, html: renderHtml(report) });
    } catch (e) {
      if (timedOut && !res.destroyed)
        send(res, 504, {
          error: "Analysis took too long. Try a shorter recording.",
        });
      else if (!controller.signal.aborted)
        send(
          res,
          e.uploadInvalid ? 413 : 422,
          e.uploadInvalid
            ? {
                error:
                  "Choose the required audio files within the configured upload limit.",
              }
            : { error: errorInfo(e).message, code: errorInfo(e).code },
        );
    } finally {
      clearTimeout(timer);
      req.removeListener("aborted", disconnect);
      res.removeListener("close", disconnect);
      try {
        if (dir)
          await rm(dir, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
      } catch {
        // A cleanup failure must be observable without logging visitor filenames or paths.
        console.error("Audio Audit temporary-file cleanup failed.");
      }
      controllers.delete(controller);
      active--;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  async function close() {
    for (const c of controllers) c.abort();
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections();
    server.closeAllConnections();
    await auditor.close();
    await closed;
    while (active) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    server,
    close,
    status: () => ({
      active,
      processing: auditor.state.active,
      queued: auditor.state.queued,
      closed: auditor.state.closed,
    }),
  };
}
if (require.main === module) {
  const environmentNumber = (name) => {
    if (process.env[name] === undefined) return undefined;
    const value = Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid ${name}.`);
    return value;
  };
  const app = createDemoServer({
    concurrency:
      environmentNumber("AUDIO_CONCURRENCY") ??
      environmentNumber("AUDIT_CONCURRENCY"),
    maxFileBytes: environmentNumber("AUDIO_MAX_FILE_BYTES"),
    maxDurationSeconds: environmentNumber("AUDIO_MAX_DURATION_SECONDS"),
    processingTimeoutMs: environmentNumber("AUDIO_TIMEOUT_MS"),
    requestTimeoutMs: environmentNumber("AUDIO_REQUEST_TIMEOUT_MS"),
    memoryBudgetMiB: environmentNumber("AUDIO_JOB_MEMORY_MIB"),
    totalMemoryBudgetMiB: environmentNumber("AUDIO_TOTAL_MEMORY_MIB"),
    maxTempBytes: environmentNumber("AUDIO_MAX_TEMP_BYTES"),
    maxRequests: environmentNumber("AUDIO_MAX_REQUESTS"),
  });
  app.server.listen(
    Number(process.env.PORT) || 7860,
    process.env.HOST || "127.0.0.1",
    () => console.log("Audio Kit demo listening."),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void app.close().then(() => {
        process.exitCode = 0;
      });
    });
}
module.exports = { createDemoServer };

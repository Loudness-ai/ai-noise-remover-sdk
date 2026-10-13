// Integration helper: the HTTP application's upload middleware owns its private temporary file.
const { createAuditor } = require("loudness-audio-kit");
const auditor = createAuditor({
  concurrency: 4,
  maxQueued: 32,
  maxDurationSeconds: 600,
});
async function analyzeRequest(req, res, privateUploadPath) {
  const controller = new AbortController();
  const disconnect = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", disconnect);
  res.once("close", disconnect);
  try {
    const report = await auditor.analyze(privateUploadPath, {
      signal: controller.signal,
    });
    if (!res.destroyed) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(report));
    }
  } catch (error) {
    if (!res.destroyed) {
      res.statusCode = error.code === "CANCELLED" ? 499 : 422;
      res.end(JSON.stringify({ code: error.code, message: error.message }));
    }
  } finally {
    req.removeListener("aborted", disconnect);
    res.removeListener("close", disconnect);
    await require("node:fs/promises")
      .unlink(privateUploadPath)
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}
module.exports = { analyzeRequest, close: () => auditor.close() };

const { createAudioClient } = require("loudness-audio-kit");
// One client per owning service, not one client per incoming request.
const client = createAudioClient({
  concurrency: 6,
  totalMemoryBudgetMiB: 3072,
  maxQueued: 100,
});
async function enhanceRequest(req, res, inputPath, outputPath) {
  const controller = new AbortController();
  const disconnect = () => {
    if (!res.writableFinished) controller.abort();
  };
  req.once("aborted", disconnect);
  res.once("close", disconnect);
  try {
    return await client.enhance(inputPath, outputPath, {
      signal: controller.signal,
      maxFileBytes: 100 * 1024 ** 2,
      maxDurationSeconds: 1800,
    });
  } finally {
    req.removeListener("aborted", disconnect);
    res.removeListener("close", disconnect);
  }
}
// The caller owns upload deletion, successful output retention and response delivery.
module.exports = { enhanceRequest, close: () => client.close() };

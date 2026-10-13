const fs = require("node:fs/promises");
function wav({
  seconds = 2,
  sampleRate = 48000,
  channels = 1,
  sample = (i, c) => 0.1 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate),
  frames = Math.round(seconds * sampleRate),
} = {}) {
  const out = Buffer.alloc(44 + frames * channels * 4);
  out.write("RIFF");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(3, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 4, 28);
  out.writeUInt16LE(channels * 4, 32);
  out.writeUInt16LE(32, 34);
  out.write("data", 36);
  out.writeUInt32LE(frames * channels * 4, 40);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++)
      out.writeFloatLE(sample(i, c), 44 + (i * channels + c) * 4);
  return out;
}
async function writeWav(path, options) {
  await fs.writeFile(path, wav(options));
  return path;
}
function noise(seed = 123) {
  let state = seed;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return (state / 4294967296 - 0.5) * 0.3;
  };
}
module.exports = { wav, writeWav, noise };

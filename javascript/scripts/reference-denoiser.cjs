// Independent whole-buffer graph runner for numerical and resource comparisons.
// Not the kit's processing implementation. One 48 kHz mono float32 input.
const fs = require("node:fs/promises");
const path = require("node:path");
const ort = require("onnxruntime-node");
async function main() {
  const [input, output, modelDir = "models/dfn3-512-v1"] =
    process.argv.slice(2);
  const bytes = await fs.readFile(input);
  if (!bytes.length || bytes.length % 4) throw Error("Invalid reference PCM.");
  const original = new Float32Array(bytes.length / 4);
  for (let i = 0; i < original.length; i++)
    original[i] = bytes.readFloatLE(i * 4);
  const framed = new Float32Array(
    Math.ceil(original.length / 512) * 512 + 1536,
  );
  framed.set(original);
  const rendered = new Float32Array(framed.length);
  const session = await ort.InferenceSession.create(
    path.join(modelDir, "denoiser_model.onnx"),
    { executionProviders: ["cpu"], intraOpNumThreads: 1, interOpNumThreads: 1 },
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(modelDir, "initial_states.json"), "utf8"),
  );
  const stateBytes = await fs.readFile(
    path.join(modelDir, "initial_states.bin"),
  );
  let states = Object.fromEntries(
    manifest.states.map((record) => {
      const data = new Float32Array(record.bytes / 4);
      for (let i = 0; i < data.length; i++)
        data[i] = stateBytes.readFloatLE(record.offset + 4 * i);
      return [record.name, new ort.Tensor("float32", data, record.shape)];
    }),
  );
  try {
    for (let offset = 0; offset < framed.length; offset += 512) {
      const frame = new ort.Tensor(
        "float32",
        framed.slice(offset, offset + 512),
        [512],
      );
      const result = await session.run({ input_frame: frame, ...states });
      rendered.set(result.enhanced_audio_frame.data, offset);
      for (const tensor of Object.values(states)) tensor.dispose();
      states = Object.fromEntries(
        session.inputNames
          .slice(1)
          .map((name, i) => [name, result[session.outputNames[i + 1]]]),
      );
      result.enhanced_audio_frame.dispose();
      frame.dispose();
    }
    const out = Buffer.alloc(original.length * 4);
    for (let i = 0; i < original.length; i++)
      out.writeFloatLE(rendered[i + 1536], i * 4);
    await fs.writeFile(output, out);
    console.log(
      JSON.stringify({
        frames: original.length,
        algorithm: "independent-whole-buffer-pinned-graph",
        parentRssBytes: process.memoryUsage().rss,
      }),
    );
  } finally {
    for (const tensor of Object.values(states)) tensor.dispose();
    await session.release();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { AuditError } from "./errors.js";

export const FRAME_SIZE = 512;
export const SPEECH_RATE = 48000;
// Pinned graph: 512-sample synthesis delay plus two frames of model lookahead.
export const MODEL_DELAY_FRAMES = 3;
export const MODEL_HASH =
  "b758c49d6708a5b7979e3de185705a8a4915076c862fb17b1b304d9a72b75cdc";
export const STATE_HASH =
  "7664728d90e7b17655cf4d308d46d42fdea6c3a69c374e494164c7cb44d783fc";
type StateRecord = {
  name: string;
  shape: number[];
  offset: number;
  bytes: number;
};

/** One session, independent recurrent state per channel. Lifetime belongs to one job. */
export class SpeechEngine {
  private states: Record<string, ort.Tensor>[] = [];
  private constructor(private session: ort.InferenceSession) {}

  static async create(
    directory: string,
    channels: number,
    threads: number,
  ): Promise<SpeechEngine> {
    // Reject oversized local replacements before allocating their contents.
    for (const [name, maximum] of [
      ["denoiser_model.onnx", 12911035],
      ["initial_states.bin", 184544],
      ["initial_states.json", 16384],
      ["meta.json", 16384],
    ] as const) {
      const info = await stat(join(directory, name)).catch((e) => {
        throw new AuditError(
          "MODEL_MISSING",
          "The local speech model assets are missing.",
          { cause: e },
        );
      });
      if (!info.isFile() || info.size > maximum)
        throw new AuditError(
          "MODEL_INVALID",
          "The local speech asset has an invalid size.",
        );
    }
    const [model, blob, manifestBytes, metadataBytes] = await Promise.all([
      readFile(join(directory, "denoiser_model.onnx")),
      readFile(join(directory, "initial_states.bin")),
      readFile(join(directory, "initial_states.json")),
      readFile(join(directory, "meta.json")),
    ]).catch((e) => {
      throw new AuditError(
        "MODEL_MISSING",
        "The local speech model assets are missing.",
        { cause: e },
      );
    });
    const hash = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    if (hash(model) !== MODEL_HASH || hash(blob) !== STATE_HASH)
      throw new AuditError(
        "MODEL_INVALID",
        "The local speech model checksum does not match.",
      );
    let records: StateRecord[];
    let inputs: string[], outputs: string[];
    try {
      const manifest = JSON.parse(manifestBytes.toString());
      const metadata = JSON.parse(metadataBytes.toString());
      records = manifest.states;
      inputs = metadata.input_names;
      outputs = metadata.output_names;
      if (
        !Array.isArray(records) ||
        !Array.isArray(inputs) ||
        !Array.isArray(outputs) ||
        inputs.length !== 13 ||
        outputs.length !== 13 ||
        records.length !== 12 ||
        inputs[0] !== "input_frame" ||
        outputs[0] !== "enhanced_audio_frame" ||
        manifest.bytes !== blob.length ||
        manifest.sha256 !== STATE_HASH
      )
        throw new Error();
      let offset = 0;
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (
          r.name !== inputs[i + 1] ||
          outputs[i + 1] !== `new_${r.name}` ||
          !Array.isArray(r.shape) ||
          !r.shape.length ||
          !r.shape.every((n) => Number.isInteger(n) && n > 0 && n <= 4096) ||
          r.offset !== offset ||
          r.bytes !== r.shape.reduce((a, n) => a * n, 4)
        )
          throw new Error();
        offset += r.bytes;
      }
      if (offset !== blob.length) throw new Error();
    } catch (e) {
      throw new AuditError(
        "MODEL_INVALID",
        "The speech state manifest is invalid.",
        { cause: e },
      );
    }
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["cpu"],
      executionMode: "sequential",
      graphOptimizationLevel: "all",
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
    });
    const engine = new SpeechEngine(session);
    try {
      if (
        session.inputNames.join() !== inputs.join() ||
        session.outputNames.join() !== outputs.join()
      )
        throw new AuditError(
          "MODEL_INVALID",
          "The speech graph contract does not match.",
        );
      engine.states = Array.from({ length: channels }, () =>
        Object.fromEntries(
          records.map((r) => {
            const values = new Float32Array(r.bytes / 4);
            for (let i = 0; i < values.length; i++)
              values[i] = blob.readFloatLE(r.offset + i * 4);
            return [r.name, new ort.Tensor("float32", values, r.shape)];
          }),
        ),
      );
      return engine;
    } catch (e) {
      await engine.close();
      throw e;
    }
  }

  async frame(samples: Float32Array, channel: number): Promise<Float32Array> {
    if (samples.length !== FRAME_SIZE || !this.states[channel])
      throw new AuditError("PCM_INVALID", "Invalid speech frame.");
    const input = new ort.Tensor("float32", samples, [FRAME_SIZE]);
    const previous = this.states[channel];
    let result: Record<string, ort.Tensor> | undefined;
    try {
      result = await this.session.run({ input_frame: input, ...previous });
      const wet = result.enhanced_audio_frame.data as Float32Array;
      if (wet.length !== FRAME_SIZE || !wet.every(Number.isFinite))
        throw new AuditError(
          "PCM_INVALID",
          "The speech engine returned invalid samples.",
        );
      const out = wet.slice();
      const next = Object.fromEntries(
        this.session.inputNames
          .slice(1)
          .map((name, i) => [name, result![this.session.outputNames[i + 1]]]),
      );
      if (Object.values(next).some((tensor) => !tensor))
        throw new AuditError(
          "MODEL_INVALID",
          "The speech engine returned incomplete state.",
        );
      for (const state of Object.values(previous)) state.dispose();
      this.states[channel] = next;
      result.enhanced_audio_frame.dispose();
      result = undefined;
      return out;
    } finally {
      input.dispose();
      if (result) for (const tensor of Object.values(result)) tensor.dispose();
    }
  }
  async close(): Promise<void> {
    for (const state of this.states)
      for (const tensor of Object.values(state)) tensor.dispose();
    this.states = [];
    await this.session.release();
  }
}

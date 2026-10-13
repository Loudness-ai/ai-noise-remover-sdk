import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  FRAME_SIZE,
  SpeechEngine,
  MODEL_DELAY_FRAMES,
} from "./speech-engine.js";
import { mediaFormats } from "./input.js";
import { AuditError, errorInfo } from "./errors.js";

interface Configuration {
  input: string;
  output: string;
  modelDir: string;
  ffmpeg: string;
  streamIndex: number;
  channels: number;
  sampleRate: number;
  threads: number;
  maxDuration: number;
  maxTempBytes: number;
  declaredDuration: number | null;
  neural: boolean;
  strength: number;
}
async function main(config: Configuration): Promise<void> {
  const started = performance.now();
  const emit = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
  emit({ phase: "initialize", fraction: null });
  const engine =
    config.neural && config.strength > 0
      ? await SpeechEngine.create(
          config.modelDir,
          config.channels,
          config.threads,
        )
      : undefined;
  const initializedMs = performance.now() - started;
  const decoder = spawn(
    config.ffmpeg,
    [
      "-nostdin",
      "-v",
      "error",
      "-threads",
      String(config.threads),
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      mediaFormats,
      "-i",
      config.input,
      "-map",
      `0:${config.streamIndex}`,
      "-vn",
      "-sn",
      "-dn",
      "-ar",
      String(config.sampleRate),
      "-ac",
      String(config.channels),
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "pipe:1",
    ],
    {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    },
  );
  let stderr = "";
  decoder.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const closed = new Promise<void>((resolve, reject) => {
    decoder.once("error", (e) =>
      reject(
        new AuditError(
          "DEPENDENCY_MISSING",
          "Could not start the audio decoder.",
          { cause: e },
        ),
      ),
    );
    decoder.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new AuditError(
              "DECODE_FAILED",
              "The input could not be decoded completely.",
            ),
          ),
    );
  });
  void closed.catch(() => {});
  let handle;
  let pending = Buffer.alloc(0),
    decodedFrames = 0,
    writtenFrames = 0;
  const delayedDry: { samples: Float32Array[]; count: number }[] = [];
  let lastProgress = 0;
  const blockBytes = FRAME_SIZE * config.channels * 4;
  try {
    handle = await open(config.output, "wx", 0o600);
    const write = async (
      channels: Float32Array[],
      count: number,
    ): Promise<void> => {
      if ((writtenFrames + count) * config.channels * 4 > config.maxTempBytes)
        throw new AuditError(
          "TEMP_LIMIT",
          "The decoded audio exceeds the configured temporary-disk budget.",
        );
      const output = Buffer.allocUnsafe(count * config.channels * 4);
      for (let i = 0; i < count; i++)
        for (let ch = 0; ch < config.channels; ch++)
          output.writeFloatLE(channels[ch][i], (i * config.channels + ch) * 4);
      let offset = 0;
      while (offset < output.length) {
        const { bytesWritten } = await handle!.write(
          output,
          offset,
          output.length - offset,
        );
        if (!bytesWritten)
          throw new AuditError(
            "OUTPUT_SPACE",
            "Could not write the processed audio.",
          );
        offset += bytesWritten;
      }
      writtenFrames += count;
    };
    const frame = async (bytes: Buffer, count: number): Promise<void> => {
      if (
        (decodedFrames + count) / config.sampleRate >
        config.maxDuration + 1 / config.sampleRate
      )
        throw new AuditError(
          "DURATION_LIMIT",
          "The decoded audio exceeds the configured duration limit.",
        );
      const dry = Array.from(
        { length: config.channels },
        () => new Float32Array(FRAME_SIZE),
      );
      for (let i = 0; i < count; i++)
        for (let ch = 0; ch < config.channels; ch++) {
          const sample = bytes.readFloatLE((i * config.channels + ch) * 4);
          if (!Number.isFinite(sample))
            throw new AuditError(
              "PCM_INVALID",
              "The recording contains non-finite samples.",
            );
          dry[ch][i] = sample;
        }
      if (engine) {
        const wet: Float32Array[] = [];
        for (let ch = 0; ch < config.channels; ch++)
          wet.push(await engine.frame(dry[ch], ch));
        if (delayedDry.length === MODEL_DELAY_FRAMES) {
          const previous = delayedDry.shift()!;
          for (let ch = 0; ch < config.channels; ch++)
            for (let i = 0; i < previous.count; i++)
              wet[ch][i] =
                config.strength * wet[ch][i] +
                (1 - config.strength) * previous.samples[ch][i];
          await write(wet, previous.count);
        }
        delayedDry.push({ samples: dry, count });
      } else await write(dry, count);
      decodedFrames += count;
      const now = performance.now();
      if (now - lastProgress > 250) {
        emit({
          phase: config.neural ? "denoise" : "decode",
          fraction: config.declaredDuration
            ? Math.min(
                0.99,
                decodedFrames / config.sampleRate / config.declaredDuration,
              )
            : null,
          decodedSeconds: decodedFrames / config.sampleRate,
        });
        lastProgress = now;
      }
    };
    for await (const chunk of decoder.stdout) {
      const bytes = pending.length
        ? Buffer.concat([pending, chunk as Buffer])
        : (chunk as Buffer);
      let offset = 0;
      for (; offset + blockBytes <= bytes.length; offset += blockBytes)
        await frame(bytes.subarray(offset, offset + blockBytes), FRAME_SIZE);
      pending = Buffer.from(bytes.subarray(offset));
    }
    await closed;
    if (pending.length % (config.channels * 4))
      throw new AuditError(
        "PCM_INVALID",
        "The decoded audio ends with an incomplete sample.",
      );
    if (pending.length)
      await frame(pending, pending.length / config.channels / 4);
    if (!decodedFrames)
      throw new AuditError(
        "PCM_INVALID",
        "The recording contains no audio samples.",
      );
    if (engine) {
      // Even a clip shorter than the delay needs all three zero frames before output.
      let processedBlocks = Math.ceil(decodedFrames / FRAME_SIZE);
      for (
        let flush = 0;
        flush < MODEL_DELAY_FRAMES;
        flush++, processedBlocks++
      ) {
        const tail: Float32Array[] = [];
        for (let ch = 0; ch < config.channels; ch++)
          tail.push(await engine.frame(new Float32Array(FRAME_SIZE), ch));
        if (processedBlocks >= MODEL_DELAY_FRAMES && delayedDry.length) {
          const previous = delayedDry.shift()!;
          for (let ch = 0; ch < config.channels; ch++)
            for (let i = 0; i < previous.count; i++)
              tail[ch][i] =
                config.strength * tail[ch][i] +
                (1 - config.strength) * previous.samples[ch][i];
          await write(tail, previous.count);
        }
      }
    }
    if (writtenFrames !== decodedFrames)
      throw new AuditError(
        "OUTPUT_INVALID",
        "The processed recording has an unexpected sample count.",
      );
    await handle.sync();
    emit({
      kind: "worker-result",
      frames: writtenFrames,
      sampleRate: config.sampleRate,
      channels: config.channels,
      initializedMs,
      wallMs: performance.now() - started,
      delayCompensatedSamples: engine ? FRAME_SIZE * MODEL_DELAY_FRAMES : 0,
    });
  } finally {
    decoder.kill("SIGKILL");
    await closed.catch(() => {});
    await handle?.close();
    await engine?.close();
  }
}
if (process.argv[2])
  main(JSON.parse(process.argv[2])).catch((e) => {
    const error =
      e?.code === "ENOSPC"
        ? new AuditError(
            "OUTPUT_SPACE",
            "There is insufficient disk space for processing.",
          )
        : e;
    process.stdout.write(
      JSON.stringify({ kind: "worker-error", ...errorInfo(error) }) + "\n",
    );
    process.exitCode = 1;
  });

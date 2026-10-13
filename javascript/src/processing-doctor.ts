import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { doctor } from "./input.js";
import { denoise } from "./processing.js";
import type { ProcessingOptions } from "./processing.js";
import { aborted, errorInfo } from "./errors.js";

/** Exercises the installed model and native decoder/encoder in an isolated child. */
export async function processingDoctor(
  options: ProcessingOptions = {},
): Promise<{
  ready: boolean;
  versions: Record<string, string>;
  errors: string[];
  speechEngine: "ready" | "unavailable";
}> {
  const native = await doctor(options);
  if (!native.ready) return { ...native, speechEngine: "unavailable" };
  const folder = await mkdtemp(
    join(options.tempDirectory ?? tmpdir(), "loudness-doctor-"),
  );
  try {
    const bytes = Buffer.alloc(44 + 512 * 2);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24);
    bytes.writeUInt32LE(96000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(1024, 40);
    const source = join(folder, "silence.wav");
    await writeFile(source, bytes, { mode: 0o600 });
    await denoise(source, join(folder, "processed.wav"), {
      ...options,
      format: "wav",
      strength: 1,
      channels: 1,
      sampleRate: 48000,
      normalize: false,
      maxFileBytes: Math.max(
        bytes.length,
        options.maxFileBytes ?? bytes.length,
      ),
      maxDurationSeconds: Math.max(1, options.maxDurationSeconds ?? 1),
      maxTempBytes: Math.max(65536, options.maxTempBytes ?? 65536),
      timeoutMs: options.timeoutMs ?? 10000,
    });
    return { ...native, speechEngine: "ready" };
  } catch (e) {
    aborted(options.signal);
    return {
      ready: false,
      versions: native.versions,
      errors: [...native.errors, `speech processing: ${errorInfo(e).code}`],
      speechEngine: "unavailable",
    };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

import { open, rename, unlink, link } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { aborted, AuditError } from "./errors.js";
export async function writeAtomic(
  destination: string,
  data: string,
  options: { overwrite?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  aborted(options.signal);
  const path = resolve(destination);
  const scratch = join(dirname(path), `.audio-audit-${randomUUID()}.tmp`);
  try {
    const handle = await open(scratch, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    aborted(options.signal);
    if (options.overwrite) await rename(scratch, path);
    else {
      await link(scratch, path);
      await unlink(scratch);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new AuditError(
        "OUTPUT_EXISTS",
        "Output already exists; enable overwrite deliberately.",
      );
    if (["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? ""))
      throw new AuditError(
        "OUTPUT_PERMISSION",
        "Cannot write the report destination; check directory permissions.",
        { cause: e },
      );
    if ((e as NodeJS.ErrnoException).code === "ENOSPC")
      throw new AuditError(
        "OUTPUT_SPACE",
        "There is insufficient disk space for the report.",
        { cause: e },
      );
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new AuditError(
        "OUTPUT_DIRECTORY",
        "The report's destination directory does not exist.",
        { cause: e },
      );
    throw e;
  } finally {
    await unlink(scratch).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}

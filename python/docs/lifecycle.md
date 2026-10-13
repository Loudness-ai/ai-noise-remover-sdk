# Job lifecycle and service integration

Use one `AudioClient` for an application's shared admission queue. Assign a unique private input and output path per request, configure concurrency plus total memory/native-thread budgets, and reject excess work using `QUEUE_FULL`. The package processes local files; an application's authenticated HTTP upload, upload cancellation and storage policy remain the application's responsibilities.

1. Validate configuration and deadline, resolve the input and inspect its selected stream.
2. Reserve a private scratch directory and a unique stage in the output directory.
3. Start one owned processing process group. Its decoder stays in that group. Decode/infer incrementally; never load a full recording into an array.
4. Measure normalization if requested, then encode into the stage.
5. Decode the stage completely and verify duration, rate and channel count. Recheck the source identity and deadline.
6. Remove raw scratch, then atomically publish with no overwrite or an explicitly requested replacement. Publication is the commit point.
7. Return measured output data. A later cancellation or failed completion notification does not delete a completed user's file.

Input identity includes device, inode, size and nanosecond modification/change times. Output checks prevent source/hard-link replacement and symlink destinations. These protect ordinary concurrent use; they do not sandbox a malicious actor with write access to the same directories. Service directories must be private and trusted.

`CancellationToken.cancel()`, `AudioFuture.cancel()`, client shutdown, asynchronous task cancellation and expired deadlines stop owned workers before scratch cleanup and settlement. Pipe queues and log tails are bounded. Active jobs do not release their scheduler slot while a worker still runs. Queued jobs may settle without starting. Progress callbacks must be short; a blocking callback also blocks that job's monitoring loop. Never close the client inside its own callback.

For a disconnected web request, call its future's `cancel()` and wait for completion/cleanup outside the event loop. Do not delete an input while the processor still owns it. Only then remove request-owned upload files. A caller's `future.result(timeout=...)` is a wait timeout, not an operation timeout. Configure `timeout_seconds` to enforce processing time.

The standalone `process_audio_async` adapter runs a job off the event loop and catches repeated cancellation until its owned processing stops. It does not impose a shared admission limit across independently started requests; put a service-wide scheduler or semaphore around it, or use `AudioClient`.

Temporary audio includes raw PCM plus the same-directory staged export. Configure the destination filesystem and `temp_directory` with enough free space and permissions. Sampled RSS/disk limits can overshoot between samples; use OS/container memory and filesystem quotas when a hard bound is required. Native-thread reservations are admission accounting, not a guarantee that libraries spawn no housekeeping threads.

SIGINT/SIGTERM in the CLI request cleanup instead of abandoning workers. Power loss, SIGKILL, interpreter termination and host crashes cannot execute Python cleanup. A production service should use graceful token cancellation, a crash-recovery sweep of its own stale private job directories/stages, and a durable job registry. Do not sweep arbitrary system temporary files. Retry only after the previous owned worker is known to have stopped; completed outputs require an explicit retention policy.

This edition processes completed local recordings. Its frame-based internals do not make the SDK a microphone callback, real-time AEC, target-speaker isolator or complete live audio-device engine.

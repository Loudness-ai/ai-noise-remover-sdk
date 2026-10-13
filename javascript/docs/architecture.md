# Local processing architecture

```text
local file -> admission / stable input inspection
           -> owned worker process
              -> streamed decoder -> bounded PCM frames -> independent channel state
              -> model delay compensation + final zero-frame flush
              -> private raw scratch file
           -> optional measured two-pass level preparation
           -> encoded staging beside final destination
           -> full decode validation
           -> source/destination recheck -> scratch removal -> atomic commit
```

The package owns the CPU inference process and its decoder. Async stream consumption and awaited writes provide backpressure. No full-file JavaScript array is used in the production path. Model initialization and each recurrent state belong to one job; jobs/channels do not share mutable speech state. All graph and packed state bytes are checked against pinned hashes, with state offsets/shapes and graph input/output names validated.

The graph runs 512-sample frames at 48 kHz. Its total transport delay is 1536 samples: synthesis delay plus two frames of lookahead. Three delayed dry frames are retained for aligned strength blending. Three zero frames flush the final samples; even recordings shorter than one frame retain their original sample count. Output is resampled back to the requested/source rate and validated against actual decoded frames. MP3 container/encoder timing receives a documented tolerance; WAV/FLAC/Opus use a two-sample duration tolerance at the output clock.

Enhance uses the same speech engine as denoise plus high-pass80Hz, gentle compression and two-pass measured loudness preparation. Normalize and convert bypass neural inference. Normalization can skip silence or warn about an unmet target/decoded lossy peak. No hidden fallback replaces a missing/tampered model with a different algorithm.

## Memory, disk and admission

RAM holds the pinned model/session, bounded stream chunks, fixed recurrent states and small delayed frame buffers. Long recordings use raw scratch disk instead of duration-proportional arrays. Scratch bytes are guarded during decoding and export, then checked again before publication. Allow enough space for raw PCM plus staged encoded output and filesystem overhead. A configurable scratch parent and atomic staging can reside on separate volumes; staging intentionally remains beside the destination.

One AudioClient owns a queue and active job limit. Memory reservations and configured native thread reservations constrain admission. Explicit concurrency exceeds two when host resources permit; the auto default is capped at8. The shared client also schedules inspection/audit work; applications creating several independent clients must budget their aggregate resources themselves.

RSS sampling uses owned process groups on Unix and is performed every100ms. Overshoot between samples is possible. Windows sampling is currently unavailable; Windows process cleanup uses taskkill trees. OS/container quotas provide hard limits. The kit does not claim CPU or memory isolation against arbitrary executables chosen by its caller.

## Cancellation and atomic publication

Each operation combines user cancellation and a whole-operation deadline. Queued jobs respect the same deadline. Abort stops the owning process group; termination completion is confirmed before rejection. Transient startup group-signalling errors are retried; a fallback signals only the still-owned child, and the group is checked for live descendants. A permanent stop failure is typed and bounded rather than hanging the caller. The worker's decoder shares its group, so killing inference also stops decoding. Subsequent normalization/encoding processes have the same owned cleanup discipline.

Failed/cancelled jobs remove scratch and staging. On success, output is fsynced and fully decoded/checked, the source and destination are rechecked, and scratch is removed before publication. No-overwrite commit uses an exclusive hard link to defeat destination creation races; intentional overwrite uses atomic rename. An output destination cannot alias the source. Batch outputs cannot reuse an input path or collide with each other. A source modified while processing is rejected before commit.

The commit is the ownership boundary: a cancellation that arrives after successful publication cannot retract the completed file. Neither process crash nor power failure is a transactional distributed rollback. In server integrations, retain returned outputs according to your storage policy, and sweep abandoned job scratch after crashed hosts restart.

## Demo boundary

The optional HTTP server adds bounded request admission, rate controls, same-origin multipart uploads and server-enforced file/duration limits. Uploaded names never select filesystem paths. Each request owns an AbortController, private upload directory and output. HTTP disconnect aborts processing. A successful audio response is streamed; upload/output storage is removed after delivery closes. The UI uses revocable local object URLs for playback/download and aborts fetch on cancellation/reset/navigation.

The downloadable SDK remains local. No Loudness.ai API, private website gateway, credentials, queue storage or production deployment files are included.

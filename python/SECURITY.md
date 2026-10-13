# Security boundaries

Only local files and trusted executable/model paths are accepted. Media decoder protocol/container allowlists prevent the built-in file path from becoming a URL/playlist fetch. Private job directories, source identity checks, bounded pipe buffers, sampled resource guards and atomic destination handling reduce accidental clobbering and runaway work.

The package is not a sandbox for hostile codecs, native binaries, model assets, benchmark manifests or shared writable directories. Run untrusted uploads in an isolated account/container with patched native dependencies, OS memory/time/filesystem limits, private storage and service admission controls. Keep the original input until its processor settles. The application owns authentication, remote uploads, request-to-job mapping, retention and recovery after a hard crash.

Benchmark manifests execute trusted commands. Never pass user-supplied manifests to that API. Custom executable paths run programs with your privileges. The pinned model contract is checksum-validated; replacing model files requires a deliberate compatible asset review.

Do not send customer recordings or secrets in a vulnerability report. Contact [contact@loudness.ai](mailto:contact@loudness.ai) with a minimal reproducible case, affected version and impact. This address is a report channel, not a promise of a response SLA.

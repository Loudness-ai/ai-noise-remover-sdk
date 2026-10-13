# Contributing

Use a supported Python virtual environment and FFmpeg/FFprobe. Install `.[dev]`, then run Ruff, Mypy and Pytest as shown in README. Tests execute real inference, export, cancellation and resource failures; do not replace them with API mocks or relax sample-count/cleanup assertions to hide a regression.

Keep a single local engine contract, independent state per channel, full recording tail and a shared absolute deadline. Do not add silent network fallback, unbounded recording arrays, shell commands from user input, unchecked output overwrite or release admission before physical worker cleanup. Preserve finite snake_case reports and typed errors. New codec/settings support needs decoded-output evidence.

Use small reviewed changes, document migration effects and retain attribution/provenance. Any public redistribution of the existing model requires its exact license/export receipt. Packaging tests must install archives outside the source checkout; editable installs alone are not delivery evidence. Do not include private website/server files or credentials.

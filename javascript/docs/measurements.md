# Definitions and interpretation

## Full-file statistics

Interleaved float64 PCM retains native rate and channel order. Frames count samples per channel, not total interleaved values. Duration is frames divided by sample rate. SHA-256 covers decoded float64 little-endian PCM; equality also requires equal rate/layout/count. It is decoded equality, not a container-file hash or equality across every decoder version.

Sample peak is maximum absolute sample amplitude relative to digital full scale. RMS uses all decoded samples including silence; the aggregate averages power over channels. Crest factor is sample peak minus RMS in decibels. DC offset is the arithmetic mean per channel. Near-full-scale counts use the configured absolute amplitude threshold and runs are consecutive samples in a channel.

Stereo correlation is mean-centered Pearson correlation; constant/silent channels are unavailable. Imbalance is channel 1 RMS minus channel 2 RMS; policy evaluation uses its absolute magnitude. More than two channels do not receive a fabricated stereo value.

Quiet detection uses approximately 100 ms full-channel-mean energy windows and a configured threshold. Minimum interval duration filters qualifying intervals. Leading/trailing silence refer to this method, not exact word boundaries. Event lists can cap while interval count/duration remain accurate.

Band energies use two one-pole low-pass estimates at 200 and 2000 Hz; low/middle/high are reconstructed differences and residuals. They are coarse, overlapping filter estimates and must not be mistaken for ideal nonoverlapping FFT bands.

## Loudness and true peak

Loudness and true peak come from the installed FFmpeg EBU R128 scanner, with native channel/rate preservation on either side. The toolkit adds typed null semantics, bounded timeline collection, output accounting and validation; it does not claim ownership of the underlying loudness algorithm.

The underlying reference is [ITU-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770). Filter behavior is documented in [FFmpeg ebur128](https://ffmpeg.org/ffmpeg-filters.html#ebur128). Verification includes calibrated signals, independent native sample-statistics checks and integrated loudness against [pyloudnorm](https://github.com/csteinmetz1/pyloudnorm) with De Man filters. A separate SciPy 16× band-limited resampling reference checks interior true peaks; thresholds are 0.15 LU and 0.25 dB for the four recorded fixtures. The high-frequency synthetic fixture fades its edges to avoid comparing finite-buffer edge ringing to interior steady-state peaks. Reproduce with `scripts/reference-check.py` and its pinned dev-only requirements. That is not full standards certification or a substitute for the applicable conformance corpus.

Multichannel input with no declared speaker layout receives `unknown_channel_layout`; integrated/temporal loudness and LRA remain unavailable rather than use guessed channel weights. Unknown stereo metadata is treated as unspecified, not as proof that channel mapping changed.

Integrated loudness needs at least 400 ms and qualifying gated energy. Momentary/short-term windows need approximately 400 ms/3 s. Empty/silent/below-gate recordings do not receive zero LUFS. Loudness range is withheld under ten seconds because startup windows can distort short-program results. Native textual summaries have 0.1-unit precision; reference comparisons use appropriate tolerance.

## Comparisons

Windowed alignment uses bounded native decoding/downsampling to 400 Hz and normalized mean-centered correlation. It excludes resampler edge regions, searches a configured lag range, and requires a strong winning peak separated from competing peaks. It samples beginning/middle/end where duration permits. It cannot detect every isolated dropout or prove continuous alignment. Gain/error estimates apply to confident low-frequency sampled windows only.

Duration change, sample-rate/layout change, measured level differences and discontinuity candidates supplement alignment. Neither these measurements nor a single reference score prove speech intelligibility, musical quality or absence of audible artifacts. Listening and appropriate reference datasets remain necessary for those conclusions.

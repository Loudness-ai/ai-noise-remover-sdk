import type { Report, Analysis, Comparison } from "./types.js";
import { validateReportShape } from "./schema-validation.js";
import { brand, wordmark } from "./brand.js";
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function checkReport(value: unknown): asserts value is Report {
  validateReportShape(value);
}

function reading(value: number | null, unit = ""): string {
  return value === null
    ? "Unavailable"
    : `${value.toFixed(2)}${unit ? " " + unit : ""}`;
}
function comparisonTable(r: Comparison): string {
  const rows: [string, number | null, number | null, string][] = [
    ["Duration", r.before.durationSeconds, r.after.durationSeconds, "s"],
    [
      "Integrated loudness",
      r.before.integratedLufs,
      r.after.integratedLufs,
      "LUFS",
    ],
    ["True peak", r.before.truePeakDbtp, r.after.truePeakDbtp, "dBTP"],
    ["RMS", r.before.rmsDbfs, r.after.rmsDbfs, "dBFS"],
    [
      "Quiet intervals",
      r.before.silence.totalSeconds,
      r.after.silence.totalSeconds,
      "s",
    ],
    [
      "Leading quiet",
      r.before.silence.leadingSeconds,
      r.after.silence.leadingSeconds,
      "s",
    ],
    [
      "Trailing quiet",
      r.before.silence.trailingSeconds,
      r.after.silence.trailingSeconds,
      "s",
    ],
  ];
  return `<h3>Measured changes</h3><div class="table-wrap"><table><thead><tr><th>Measurement</th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>${rows.map(([label, a, b, unit]) => `<tr><td>${label}</td><td>${reading(a, unit)}</td><td>${reading(b, unit)}</td><td>${reading(a === null || b === null ? null : b - a, unit === "LUFS" ? "LU" : unit === "dBFS" || unit === "dBTP" ? "dB" : unit)}</td></tr>`).join("")}</tbody></table></div><p class="help">Changes are after minus before. These measurements do not rate listening quality. Per-channel and coarse band differences are included in the structured results.</p>`;
}
function analysisSection(a: Analysis): string {
  const cards = [
    ["Duration", reading(a.durationSeconds, "s")],
    ["Integrated loudness", reading(a.integratedLufs, "LUFS")],
    ["True peak", reading(a.truePeakDbtp, "dBTP")],
    ["RMS", reading(a.rmsDbfs, "dBFS")],
    ["Loudness range", reading(a.loudnessRangeLu, "LU")],
    ["Silence", reading(a.silence.totalSeconds, "s")],
  ];
  const wave = a.waveform
    .map((p) => {
      const x = (p.startSeconds / a.durationSeconds) * 1000;
      const w = Math.max(
        0.2,
        ((p.endSeconds - p.startSeconds) / a.durationSeconds) * 1000,
      );
      const min = Math.max(-1, Math.min(1, p.min)),
        max = Math.max(-1, Math.min(1, p.max));
      return `<rect x="${x}" y="${60 - max * 55}" width="${w}" height="${Math.max(0.5, (max - min) * 55)}"/>`;
    })
    .join("");
  const loud = a.loudnessTimeline
    .filter((p) => p.momentaryLufs !== null)
    .map(
      (p) =>
        `${Math.max(0, Math.min(1000, (p.timeSeconds / a.durationSeconds) * 1000))},${Math.max(0, Math.min(120, (-p.momentaryLufs! - 5) * 2))}`,
    )
    .join(" ");
  return `<section><h2>${escapeHtml(a.input.file.name)}</h2><p>${escapeHtml(a.input.selectedStream.codec)} · ${a.channels.length} channels · ${a.input.selectedStream.sampleRate} Hz · ${escapeHtml(a.state)}</p><div class="metrics">${cards.map(([k, v]) => `<div><span>${k}</span><output>${v}</output></div>`).join("")}</div><h3>Waveform</h3><svg viewBox="0 0 1000 120" role="img" aria-label="Full recording peak envelope" class="chart"><line x1="0" y1="60" x2="1000" y2="60" stroke="#dddddd"/><g fill="#ff4b1f">${wave}</g></svg><h3>Momentary loudness</h3><svg viewBox="0 0 1000 120" role="img" aria-label="Momentary loudness timeline" class="chart"><polyline points="${loud}" fill="none" stroke="#000000" stroke-width="2"/></svg><div class="table-wrap"><table><thead><tr><th>Channel</th><th>Sample peak</th><th>RMS</th><th>DC offset</th><th>Near full scale</th></tr></thead><tbody>${a.channels.map((c, i) => `<tr><td>${i + 1}</td><td>${reading(c.samplePeakDbfs, "dBFS")}</td><td>${reading(c.rmsDbfs, "dBFS")}</td><td>${c.dcOffset.toExponential(3)}</td><td>${c.nearFullScaleSamples}</td></tr>`).join("")}</tbody></table></div><p class="help">Loudness range requires at least 10 seconds. Waveform bins cover the full recording; event lists may be capped. Near-full-scale samples and sample jumps are candidates for inspection, not a listening-quality verdict.</p></section>`;
}
function body(report: Report): string {
  switch (report.kind) {
    case "analysis":
      return analysisSection(report);
    case "validation":
      return `<section><h2>${escapeHtml(report.policy.name)}</h2><p>${report.failed ? "Policy failed" : report.passed ? "Policy passed" : "Policy has warnings or unavailable measurements"}</p><ul>${report.results.map((r) => `<li><strong>${escapeHtml(r.metric)}</strong> — ${escapeHtml(r.status)} · ${escapeHtml(r.value)} ${escapeHtml(r.unit)}<p>${escapeHtml(r.message)}${r.min !== undefined ? ` Minimum: ${escapeHtml(r.min)} ${escapeHtml(r.unit)}.` : ""}${r.max !== undefined ? ` Maximum: ${escapeHtml(r.max)} ${escapeHtml(r.unit)}.` : ""}</p></li>`).join("")}</ul></section>${analysisSection(report.analysis)}`;
    case "comparison":
      return `<section><h2>Before / after comparison</h2><p>Duration difference: ${reading(report.durationDeltaSeconds, "s")} · Decoded PCM equal: ${report.decodedPcmEqual ? "yes" : "no"}</p>${comparisonTable(report)}<ul>${report.findings.map((f) => `<li>${escapeHtml(f.severity)}: ${escapeHtml(f.message)}</li>`).join("")}</ul><div class="table-wrap"><table><tr><th>Window start</th><th>Offset</th><th>Confidence</th></tr>${report.alignment.map((w) => `<tr><td>${reading(w.atSeconds, "s")}</td><td>${reading(w.offsetSeconds, "s")}</td><td>${escapeHtml(w.confidence)}</td></tr>`).join("")}</table></div>${report.limitations.map((l) => `<p class="help">${escapeHtml(l)}</p>`).join("")}</section><h2>Before</h2>${analysisSection(report.before)}<h2>After</h2>${analysisSection(report.after)}`;
    case "batch":
      return `<section><h2>Batch results</h2><ul>${report.results.map((r) => `<li>${escapeHtml(r.file)} — ${escapeHtml(r.state)}${r.error ? `: ${escapeHtml(r.error.message)}` : ""}</li>`).join("")}</ul></section>${report.results.flatMap((r) => (r.analysis ? [analysisSection(r.analysis)] : [])).join("")}`;
    case "benchmark":
      return `<section><h2>Processor benchmark</h2><div class="table-wrap"><table><tr><th>Fixture</th><th>Processor</th><th>Successes / failures</th><th>Median</th><th>p95</th></tr>${report.summaries.map((s) => `<tr><td>${escapeHtml(s.fixture)}</td><td>${escapeHtml(s.processor)}</td><td>${s.successes} / ${s.failures}</td><td>${reading(s.medianMs, "ms")}</td><td>${reading(s.p95Ms, "ms")}</td></tr>`).join("")}</table></div>${report.limitations.map((l) => `<p class="help">${escapeHtml(l)}</p>`).join("")}</section>`;
    case "inspection":
      return `<section><h2>${escapeHtml(report.file.name)}</h2><p>${escapeHtml(report.file.container)} · ${report.file.sizeBytes} bytes</p><pre>${escapeHtml(JSON.stringify(report.streams, null, 2))}</pre></section>`;
  }
}
export function renderHtml(report: Report): string {
  checkReport(report);
  const bars = brand.bars
    .map(
      ({ x, height: h }) =>
        `<line x1="${x}" x2="${x}" y1="${brand.centerY - h / 2}" y2="${brand.centerY + h / 2}"/>`,
    )
    .join("");
  const words = wordmark.glyphs
    .map(
      (g) =>
        `<path d="${g.d}" transform="translate(${g.x} 0)" fill="${g.color === "\u0023000000" ? "#ffffff" : g.color}"/>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>Loudness.ai Audio Audit report</title><style>*{box-sizing:border-box}body{margin:0;overflow-wrap:anywhere;background:#ffffff;color:#000000;font:16px/1.6 sans-serif}header{background:#000000;color:#ffffff;padding:28px max(20px,calc((100vw - 1080px)/2))}header a{color:#ff4b1f}.brand{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:800}.brand svg{width:42px;height:42px}main{max-width:1120px;margin:auto;padding:24px}h1{font-size:clamp(26px,4vw,38px);margin:12px 0}h2{font-size:24px}h3{font-size:18px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.metrics div{background:#f4f4f4;border-radius:12px;padding:14px}.metrics span{display:block;font-size:14px}output{font:600 20px/1.5 monospace}.chart{width:100%;height:140px;background:#fafafa;border-radius:12px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left}td,th{padding:12px;border-bottom:1px solid #dddddd}section{margin:0 0 36px}li{margin:8px 0}.help{font-size:14px}pre{overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}details{background:#f4f4f4;border-radius:12px;padding:16px}footer{padding:24px;border-top:1px solid #dddddd}footer a{color:#000000}@media(max-width:600px){main{padding:16px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}output{font-size:17px}td,th{padding:8px}}@media print{header{background:#ffffff;color:#000000}.chart{break-inside:avoid}details{display:none}}</style></head><body><header><div class="brand"><svg viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="7" fill="#000000"/><g stroke="#ff4b1f" stroke-width="1.8" stroke-linecap="round">${bars}</g></svg><svg viewBox="0 0 ${wordmark.advance} 681" role="img" aria-label="Loudness.ai" style="width:190px;height:32px"><g transform="translate(0 670) scale(1 -1)">${words}</g></svg></div><h1>Audio Audit report</h1><p>Measurements, delivery checks and processing comparisons.</p></header><main>${body(report)}<details><summary>Complete structured results</summary><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></details></main><footer>Created with <a href="https://loudness.ai/">Loudness.ai Audio Audit</a>. Audio remains on the system running the toolkit.</footer></body></html>`;
}

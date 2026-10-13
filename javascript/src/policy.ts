import { AuditError } from "./errors.js";
import { analyze } from "./analysis.js";
import type {
  Analysis,
  Options,
  Policy,
  Validation,
  Metric,
  RuleResult,
} from "./types.js";
const metrics: Metric[] = [
  "durationSeconds",
  "sizeBytes",
  "channels",
  "sampleRate",
  "integratedLufs",
  "truePeakDbtp",
  "samplePeakDbfs",
  "rmsDbfs",
  "nearFullScaleSamples",
  "longestNearFullScaleRun",
  "maxAbsDcOffset",
  "silenceSeconds",
  "leadingSilenceSeconds",
  "trailingSilenceSeconds",
  "channelImbalanceDb",
];
const units: Record<Metric, string> = {
  durationSeconds: "s",
  sizeBytes: "bytes",
  channels: "channels",
  sampleRate: "Hz",
  integratedLufs: "LUFS",
  truePeakDbtp: "dBTP",
  samplePeakDbfs: "dBFS",
  rmsDbfs: "dBFS",
  nearFullScaleSamples: "samples",
  longestNearFullScaleRun: "samples",
  maxAbsDcOffset: "FS",
  silenceSeconds: "s",
  leadingSilenceSeconds: "s",
  trailingSilenceSeconds: "s",
  channelImbalanceDb: "dB",
};
export function checkPolicy(value: unknown): asserts value is Policy {
  if (!value || typeof value !== "object")
    throw new AuditError("POLICY_INVALID", "A policy must be an object.");
  const p = value as Policy;
  if (
    p.schemaVersion !== 1 ||
    typeof p.name !== "string" ||
    !p.name.length ||
    !Array.isArray(p.rules) ||
    p.rules.length > 1000 ||
    Object.keys(p).some(
      (k) =>
        ![
          "schemaVersion",
          "name",
          "rules",
          "codecs",
          "containers",
          "unavailable",
        ].includes(k),
    )
  )
    throw new AuditError(
      "POLICY_INVALID",
      "Invalid policy header or unknown option.",
    );
  for (const rule of p.rules) {
    if (
      !rule ||
      !metrics.includes(rule.metric) ||
      (rule.min === undefined && rule.max === undefined) ||
      (rule.min !== undefined && !Number.isFinite(rule.min)) ||
      (rule.max !== undefined && !Number.isFinite(rule.max)) ||
      (rule.min !== undefined &&
        rule.max !== undefined &&
        rule.min > rule.max) ||
      (rule.severity !== undefined &&
        !["warning", "fail"].includes(rule.severity)) ||
      Object.keys(rule).some(
        (k) => !["metric", "min", "max", "severity"].includes(k),
      )
    )
      throw new AuditError(
        "POLICY_INVALID",
        "A policy rule has invalid bounds, metric or options.",
      );
  }
  for (const list of [p.codecs, p.containers])
    if (
      list !== undefined &&
      (!Array.isArray(list) ||
        !list.length ||
        !list.every((v) => typeof v === "string" && v.length > 0))
    )
      throw new AuditError(
        "POLICY_INVALID",
        "Codec/container constraints must be nonempty string arrays.",
      );
  if (
    p.unavailable !== undefined &&
    !["warning", "fail"].includes(p.unavailable)
  )
    throw new AuditError(
      "POLICY_INVALID",
      "Invalid unavailable-measurement policy.",
    );
}
function metric(a: Analysis, key: Metric): number | null {
  switch (key) {
    case "sizeBytes":
      return a.input.file.sizeBytes;
    case "channels":
      return a.channels.length;
    case "sampleRate":
      return a.input.selectedStream.sampleRate;
    case "nearFullScaleSamples":
      return a.channels.reduce((n, c) => n + c.nearFullScaleSamples, 0);
    case "longestNearFullScaleRun":
      return Math.max(...a.channels.map((c) => c.longestNearFullScaleRun));
    case "maxAbsDcOffset":
      return Math.max(...a.channels.map((c) => Math.abs(c.dcOffset)));
    case "silenceSeconds":
      return a.silence.totalSeconds;
    case "leadingSilenceSeconds":
      return a.silence.leadingSeconds;
    case "trailingSilenceSeconds":
      return a.silence.trailingSeconds;
    case "channelImbalanceDb":
      return a.channelImbalanceDb === null
        ? null
        : Math.abs(a.channelImbalanceDb);
    default:
      return a[key];
  }
}
export function evaluate(analysis: Analysis, policy: Policy): Validation {
  checkPolicy(policy);
  const results: RuleResult[] = [];
  for (const rule of policy.rules) {
    const value = metric(analysis, rule.metric);
    const outside =
      value !== null &&
      ((rule.min !== undefined && value < rule.min) ||
        (rule.max !== undefined && value > rule.max));
    const status =
      value === null
        ? "unavailable"
        : outside
          ? (rule.severity ?? "fail")
          : "pass";
    results.push({
      metric: rule.metric,
      unit: units[rule.metric],
      status,
      value,
      min: rule.min,
      max: rule.max,
      message:
        value === null
          ? "This measurement is unavailable for this recording."
          : outside
            ? "The measurement is outside the configured bounds."
            : "The measurement meets the configured bounds.",
    });
  }
  for (const [name, list, value] of [
    ["codec", policy.codecs, analysis.input.selectedStream.codec],
    ["container", policy.containers, analysis.input.file.container],
  ] as const)
    if (list) {
      const pass = value.split(",").some((v) => list.includes(v));
      results.push({
        metric: name,
        unit: "",
        status: pass ? "pass" : "fail",
        value,
        message: pass
          ? "The format is permitted."
          : "The format is not in the permitted list.",
      });
    }
  const failed = results.some(
    (r) =>
      r.status === "fail" ||
      (r.status === "unavailable" && policy.unavailable === "fail"),
  );
  return {
    schemaVersion: 1,
    kind: "validation",
    policy: structuredClone(policy),
    failed,
    passed: !failed && results.every((r) => r.status === "pass"),
    results,
    analysis,
  };
}
export async function validate(
  file: string,
  policy: Policy,
  options: Options = {},
): Promise<Validation> {
  checkPolicy(policy);
  return evaluate(await analyze(file, options), policy);
}
export const examplePolicy: Policy = {
  schemaVersion: 1,
  name: "Example speech delivery settings",
  unavailable: "warning",
  rules: [
    { metric: "integratedLufs", min: -20, max: -14 },
    { metric: "truePeakDbtp", max: -1 },
    { metric: "nearFullScaleSamples", max: 0 },
    { metric: "maxAbsDcOffset", max: 0.01, severity: "warning" },
  ],
};

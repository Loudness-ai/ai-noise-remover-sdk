import {
  analyze,
  evaluate,
  examplePolicy,
  renderHtml,
  writeAtomic,
} from "loudness-audio-kit";
const file = process.argv[2];
if (!file) throw Error("Usage: node analyze.mjs recording.wav");
const report = await analyze(file);
const checked = evaluate(report, examplePolicy);
console.log(JSON.stringify(checked, null, 2));
if (process.argv[3]) await writeAtomic(process.argv[3], renderHtml(checked));

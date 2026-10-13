import {
  analyze,
  evaluate,
  examplePolicy,
  type Options,
  type Validation,
} from "loudness-audio-kit/core";
const file = process.argv[2];
if (!file)
  throw new Error(
    "Usage: node typescript.mts recording.wav (Node 24), or compile with TypeScript.",
  );
const options: Options = { maxPoints: 256 };
const checked: Validation = evaluate(
  await analyze(file, options),
  examplePolicy,
);
console.log(JSON.stringify(checked, null, 2));

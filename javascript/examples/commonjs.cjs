const { analyze } = require("loudness-audio-kit");
if (!process.argv[2]) throw Error("Usage: node commonjs.cjs recording.wav");
analyze(process.argv[2])
  .then((report) => console.log(JSON.stringify(report, null, 2)))
  .catch((error) => {
    console.error(error.code, error.message);
    process.exitCode = 1;
  });

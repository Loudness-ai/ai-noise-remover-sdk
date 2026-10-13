import ts from "typescript";
import { writeFile, readFile } from "node:fs/promises";
import { format } from "prettier";
const checking = process.argv.includes("--check");
async function publish(path, text) {
  if (checking) {
    if ((await readFile(path, "utf8")) !== text)
      throw Error(`Generated schema drift: ${path}`);
  } else await writeFile(path, text);
}
const files = ["src/types.ts", "src/processing.ts", "src/audio-client.ts"];
const program = ts.createProgram(files, {
  strictNullChecks: true,
  types: [],
});
const checker = program.getTypeChecker();
const source = program.getSourceFile("src/types.ts");
function generate(rootName) {
  const defs = {};
  function shape(type, inline = false) {
    if (type.flags & ts.TypeFlags.StringLiteral)
      return { const: type.value, type: "string" };
    if (type.flags & ts.TypeFlags.NumberLiteral)
      return { const: type.value, type: "number" };
    if (type.flags & ts.TypeFlags.BooleanLiteral)
      return { const: type.intrinsicName === "true", type: "boolean" };
    if (type.flags & ts.TypeFlags.String) return { type: "string" };
    if (type.flags & ts.TypeFlags.Number) return { type: "number" };
    if (type.flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (type.flags & ts.TypeFlags.Null) return { type: "null" };
    if (type.isUnion())
      return {
        anyOf: type.types
          .filter((t) => !(t.flags & ts.TypeFlags.Undefined))
          .map((t) => shape(t)),
      };
    if (checker.isArrayType(type))
      return { type: "array", items: shape(checker.getTypeArguments(type)[0]) };
    const name = type.symbol?.name;
    if (!inline && name && name !== "__type" && !name.startsWith("__")) {
      if (!defs[name]) {
        defs[name] = {};
        defs[name] = shape(type, true);
      }
      return { $ref: "#/$defs/" + name };
    }
    const properties = {},
      required = [];
    for (const p of checker.getPropertiesOfType(type)) {
      properties[p.name] = shape(
        checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? source),
      );
      if (!(p.flags & ts.SymbolFlags.Optional)) required.push(p.name);
    }
    const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    return {
      type: "object",
      properties,
      required,
      additionalProperties: indexed ? shape(indexed) : false,
    };
  }
  const declaration = files
    .flatMap((file) => program.getSourceFile(file).statements)
    .find((s) => s.name?.text === rootName);
  if (!declaration) throw Error("Unknown type " + rootName);
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: rootName,
    ...shape(checker.getTypeAtLocation(declaration)),
    $defs: defs,
  };
  return schema;
}
for (const name of [
  "Report",
  "Inspection",
  "Analysis",
  "Validation",
  "Comparison",
  "Batch",
  "Benchmark",
  "Policy",
  "BenchmarkManifest",
  "ProcessingResult",
  "ProcessingBatchResult",
]) {
  const schema = generate(name);
  await publish(
    `schemas/${name.toLowerCase()}.schema.json`,
    JSON.stringify(schema, null, 2) + "\n",
  );
  if (name === "Report")
    await publish(
      "src/report-schema.ts",
      await format(
        "// Generated from types.ts by scripts/schemas.mjs. Do not edit by hand.\nexport const reportSchema = " +
          JSON.stringify(schema) +
          ";\n",
        { parser: "typescript" },
      ),
    );
}
console.log(
  checking
    ? "Schemas match public TypeScript contracts."
    : "Generated JSON schemas from public TypeScript contracts.",
);

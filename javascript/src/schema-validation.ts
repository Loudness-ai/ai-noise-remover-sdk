import { reportSchema } from "./report-schema.js";
import { AuditError } from "./errors.js";
type Schema = {
  type?: string;
  const?: unknown;
  anyOf?: Schema[];
  $ref?: string;
  $defs?: Record<string, Schema>;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
};
/** Validator for the generated schema subset; no coercion or prototype mutations. */
export function validateReportShape(value: unknown): void {
  const root = reportSchema as Schema;
  let nodes = 0;
  function matches(v: unknown, s: Schema, depth: number): boolean {
    if (++nodes > 2_000_000 || depth > 32)
      throw new AuditError(
        "REPORT_LIMIT",
        "The report exceeds structural limits.",
      );
    if (s.$ref)
      return matches(v, root.$defs![s.$ref.split("/").at(-1)!], depth + 1);
    if (s.anyOf)
      return s.anyOf.some((candidate) => matches(v, candidate, depth + 1));
    if ("const" in s && v !== s.const) return false;
    if (s.type === "null") return v === null;
    if (s.type === "number") return typeof v === "number" && Number.isFinite(v);
    if (s.type === "string") return typeof v === "string";
    if (s.type === "boolean") return typeof v === "boolean";
    if (s.type === "array")
      return (
        Array.isArray(v) &&
        v.length <= 100000 &&
        v.every((item) => matches(item, s.items!, depth + 1))
      );
    if (s.type === "object") {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const object = v as Record<string, unknown>;
      if ((s.required ?? []).some((k) => !Object.hasOwn(object, k)))
        return false;
      for (const [key, item] of Object.entries(object)) {
        const property =
          s.properties && Object.hasOwn(s.properties, key)
            ? s.properties[key]
            : undefined;
        if (property) {
          if (item !== undefined && !matches(item, property, depth + 1))
            return false;
        } else if (s.additionalProperties === false) return false;
        else if (
          typeof s.additionalProperties === "object" &&
          !matches(item, s.additionalProperties, depth + 1)
        )
          return false;
      }
      return true;
    }
    return true;
  }
  if (!matches(value, root, 0))
    throw new AuditError(
      "REPORT_INVALID",
      "The report does not match its documented schema.",
    );
}

import { Ajv, type ValidateFunction } from "ajv";

// Compiled validators keyed by schema text; a coordinator reuses one schema across a batch.
// Each entry compiles on an Ajv of its own: Ajv keeps every schema it compiles and refuses a
// repeated $id, so a shared instance would leak evicted schemas and let one result's schema
// fail, or be referenced by, another's. Evicting an entry releases everything it compiled.
const compiled = new Map<string, ValidateFunction | string>();
const MAX_COMPILED = 64;

function containsRegexKeyword(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      key === "pattern" || key === "patternProperties" || containsRegexKeyword(nested),
  );
}

function compile(schema: object): ValidateFunction | string {
  const key = JSON.stringify(schema);
  const cached = compiled.get(key);
  if (cached !== undefined) return cached;
  let result: ValidateFunction | string;
  try {
    result = containsRegexKeyword(schema)
      ? "the schema is invalid: pattern and patternProperties are not supported"
      : new Ajv({ strict: false }).compile(schema);
  } catch (error) {
    result = `the schema is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (compiled.size >= MAX_COMPILED) compiled.delete(compiled.keys().next().value!);
  compiled.set(key, result);
  return result;
}

/** Returns the first way `value` breaks `schema`, or null when it matches. */
export function validateJsonSchema(schema: object, value: unknown): string | null {
  const validate = compile(schema);
  if (typeof validate === "string") return validate;
  if (validate(value)) return null;
  const error = validate.errors?.[0];
  if (error === undefined) return "it does not match";
  const path = `$${error.instancePath.replaceAll("/", ".")}`;
  const detail =
    error.keyword === "additionalProperties"
      ? `has unexpected property ${String((error.params as { additionalProperty?: unknown }).additionalProperty)}`
      : (error.message ?? "does not match");
  return `${path} ${detail}`;
}

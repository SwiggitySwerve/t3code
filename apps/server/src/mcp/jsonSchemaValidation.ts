import { Ajv, type ValidateFunction } from "ajv";

const ajv = new Ajv({ strict: false });
// Compiled validators keyed by schema text; a coordinator reuses one schema across a batch.
const compiled = new Map<string, ValidateFunction | string>();
const MAX_COMPILED = 64;

function compile(schema: object): ValidateFunction | string {
  const key = JSON.stringify(schema);
  const cached = compiled.get(key);
  if (cached !== undefined) return cached;
  let result: ValidateFunction | string;
  try {
    result = ajv.compile(schema);
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

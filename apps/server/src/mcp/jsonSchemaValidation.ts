/**
 * Checks the JSON Schema keywords a delegated result usually needs: type,
 * enum, const, required, properties, additionalProperties: false, and items.
 * Other keywords are accepted without a check. Returns the first problem, or
 * null when none was found.
 */
export function validateJsonSchema(schema: unknown, value: unknown, path = "$"): string | null {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return null;
  const rule = schema as Readonly<Record<string, unknown>>;
  if (rule.type !== undefined) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (!types.some((type) => matchesType(type, value))) {
      return `${path} should be ${types.join(" or ")}`;
    }
  }
  if (Array.isArray(rule.enum) && !rule.enum.some((option) => sameJson(option, value))) {
    return `${path} should be one of ${JSON.stringify(rule.enum)}`;
  }
  if ("const" in rule && !sameJson(rule.const, value)) {
    return `${path} should be ${JSON.stringify(rule.const)}`;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    for (const key of Array.isArray(rule.required) ? rule.required : []) {
      if (typeof key === "string" && !(key in record)) return `${path}.${key} is required`;
    }
    const properties =
      typeof rule.properties === "object" && rule.properties !== null
        ? (rule.properties as Readonly<Record<string, unknown>>)
        : {};
    for (const [key, child] of Object.entries(record)) {
      if (key in properties) {
        const problem = validateJsonSchema(properties[key], child, `${path}.${key}`);
        if (problem !== null) return problem;
      } else if (rule.additionalProperties === false) {
        return `${path}.${key} is not allowed`;
      }
    }
  }
  if (Array.isArray(value) && rule.items !== undefined) {
    for (const [index, item] of value.entries()) {
      const problem = validateJsonSchema(rule.items, item, `${path}[${index}]`);
      if (problem !== null) return problem;
    }
  }
  return null;
}

function matchesType(type: unknown, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return true;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

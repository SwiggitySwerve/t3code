/**
 * A delegated task can ask its child for a JSON result. This module owns both
 * halves of that format: the instruction appended to the child's prompt, and
 * reading the result back, so the marker it writes is the only one it parses.
 */
const SCHEMA_OPEN = "<t3-result-schema>";
const SCHEMA_CLOSE = "</t3-result-schema>";

export type JsonSchemaObject = Readonly<Record<string, unknown>>;

export function withResultSchema(prompt: string, schema: JsonSchemaObject | undefined): string {
  if (schema === undefined) return prompt;
  return [
    prompt,
    "",
    "Your final message must end with exactly one fenced ```json code block whose value matches this JSON Schema. Put any explanation before that block.",
    SCHEMA_OPEN,
    JSON.stringify(schema),
    SCHEMA_CLOSE,
  ].join("\n");
}

export function resultSchemaOf(prompt: string): JsonSchemaObject | undefined {
  const end = prompt.lastIndexOf(SCHEMA_CLOSE);
  const start = end < 0 ? -1 : prompt.lastIndexOf(SCHEMA_OPEN, end);
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(prompt.slice(start + SCHEMA_OPEN.length, end));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonSchemaObject)
      : undefined;
  } catch {
    return undefined;
  }
}

const FENCED_JSON = /```json[^\n]*\n([\s\S]*?)\n?```/g;

export type StructuredResult =
  | { readonly structuredResult: unknown }
  | { readonly structuredResultError: string };

/** Reads the last fenced json block of a child's result and checks it against the schema. */
export function readStructuredResult(
  summary: string,
  validate: (value: unknown) => string | null,
): StructuredResult {
  const blocks = [...summary.matchAll(FENCED_JSON)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) {
    return { structuredResultError: "The result has no fenced ```json block." };
  }
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch (error) {
    return {
      structuredResultError: `The last json block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const problem = validate(value);
  return problem === null
    ? { structuredResult: value }
    : { structuredResultError: `The result does not match the schema: ${problem}` };
}

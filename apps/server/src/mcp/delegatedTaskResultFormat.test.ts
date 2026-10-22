import { describe, expect, it } from "vitest";

import {
  readStructuredResult,
  resultSchemaOf,
  withResultSchema,
} from "./delegatedTaskResultFormat.ts";
import { validateJsonSchema } from "./jsonSchemaValidation.ts";

const schema = {
  type: "object",
  required: ["verdict", "issues"],
  additionalProperties: false,
  properties: {
    verdict: { enum: ["pass", "fail"] },
    issues: { type: "array", items: { type: "string" } },
  },
};
const validate = (value: unknown) => validateJsonSchema(schema, value);

describe("delegated task result format", () => {
  it("round-trips the schema through the child's prompt", () => {
    const prompt = withResultSchema("Review the diff.", schema);
    expect(prompt.startsWith("Review the diff.\n")).toBe(true);
    expect(resultSchemaOf(prompt)).toEqual(schema);
    expect(resultSchemaOf("Review the diff.")).toBeUndefined();
    expect(withResultSchema("Review the diff.", undefined)).toBe("Review the diff.");
  });

  it("reads the last json block and checks it", () => {
    const summary = [
      'Draft: ```json\n{"verdict":"pass"}\n```',
      "Final:",
      "```json",
      '{"verdict":"fail","issues":["missing test"]}',
      "```",
    ].join("\n");
    expect(readStructuredResult(summary, validate)).toEqual({
      structuredResult: { verdict: "fail", issues: ["missing test"] },
    });
  });

  it("explains a missing block, invalid JSON, and a schema mismatch", () => {
    expect(readStructuredResult("No block here.", validate)).toEqual({
      structuredResultError: "The result has no fenced ```json block.",
    });
    expect(readStructuredResult("```json\n{verdict:\n```", validate)).toMatchObject({
      structuredResultError: expect.stringContaining("not valid JSON"),
    });
    expect(readStructuredResult('```json\n{"verdict":"maybe","issues":[]}\n```', validate)).toEqual(
      {
        structuredResultError:
          'The result does not match the schema: $.verdict should be one of ["pass","fail"]',
      },
    );
  });

  it("checks required, extra, and nested keys", () => {
    expect(validate({ verdict: "pass" })).toBe("$.issues is required");
    expect(validate({ verdict: "pass", issues: [], note: "x" })).toBe("$.note is not allowed");
    expect(validate({ verdict: "pass", issues: [1] })).toBe("$.issues[0] should be string");
    expect(validate({ verdict: "pass", issues: ["a"] })).toBeNull();
  });
});

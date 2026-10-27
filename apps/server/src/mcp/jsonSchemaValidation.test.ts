// @effect-diagnostics nodeBuiltinImport:off -- the retention proof needs V8's collector.
import * as NodeFSP from "node:fs/promises";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";

import { describe, expect, it } from "@effect/vitest";

import { validateJsonSchema } from "./jsonSchemaValidation.ts";

// More distinct schemas than any bounded compile cache keeps, so each earlier one is evicted.
const FILLERS = 256;
const evictEverything = () => {
  for (let index = 0; index < FILLERS; index += 1) {
    validateJsonSchema({ type: "object", title: `filler ${index}` }, {});
  }
};
// A fresh parse of the same text, which is what each task read hands the validator.
const reparsed = (schema: object): object => JSON.parse(JSON.stringify(schema));

describe("JSON Schema validation", () => {
  it("reports the first mismatch with its path", () => {
    const schema = {
      type: "object",
      required: ["verdict"],
      additionalProperties: false,
      properties: { verdict: { enum: ["pass", "fail"] }, issues: { type: "array" } },
    };
    expect(validateJsonSchema(schema, { verdict: "pass" })).toBeNull();
    expect(validateJsonSchema(schema, {})).toBe("$ must have required property 'verdict'");
    expect(validateJsonSchema(schema, { verdict: "pass", note: 1 })).toBe(
      "$ has unexpected property note",
    );
    expect(validateJsonSchema(schema, { verdict: "pass", issues: 1 })).toBe(
      "$.issues must be array",
    );
    expect(validateJsonSchema({ type: "nonsense" }, 1)).toContain("the schema is invalid");
  });

  it("resolves references inside the schema that declares them", () => {
    const schema = {
      $id: "urn:test:tree",
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        child: { $ref: "#/$defs/leaf" },
        next: { $ref: "urn:test:tree" },
      },
      $defs: { leaf: { type: "object", required: ["id"] } },
    };
    expect(
      validateJsonSchema(schema, { name: "a", child: { id: 1 }, next: { name: "b" } }),
    ).toBeNull();
    expect(validateJsonSchema(schema, { name: "a", child: {} })).toBe(
      "$.child must have required property 'id'",
    );
    expect(validateJsonSchema(schema, { name: "a", next: {} })).toBe(
      "$.next must have required property 'name'",
    );
  });

  it("keeps validating a schema with an $id after other schemas push it out of the cache", () => {
    const schema = { $id: "urn:test:result", type: "object", required: ["ok"] };
    expect(validateJsonSchema(schema, { ok: true })).toBeNull();
    evictEverything();
    expect(validateJsonSchema(reparsed(schema), { ok: true })).toBeNull();
    expect(validateJsonSchema(reparsed(schema), {})).toBe("$ must have required property 'ok'");
  });

  it("keeps schemas that reuse an $id apart", () => {
    const text = { $id: "urn:test:shared", type: "string" };
    const number = { $id: "urn:test:shared", type: "number" };
    expect(validateJsonSchema(text, "a")).toBeNull();
    expect(validateJsonSchema(number, 1)).toBeNull();
    expect(validateJsonSchema(text, 1)).toBe("$ must be string");
    expect(validateJsonSchema(number, "a")).toBe("$ must be number");
  });

  it("never resolves a reference to a schema another result declared", () => {
    expect(validateJsonSchema({ $id: "urn:test:private", type: "string" }, "a")).toBeNull();
    const outsider = { type: "object", properties: { value: { $ref: "urn:test:private" } } };
    expect(validateJsonSchema(outsider, { value: 1 })).toContain("the schema is invalid");
  });

  it("lets go of schemas it no longer caches", async () => {
    NodeV8.setFlagsFromString("--expose-gc");
    const collect = NodeVM.runInNewContext("gc") as () => void;
    const watched = (() => {
      const schema = { type: "object", title: "watched" };
      validateJsonSchema(schema, {});
      return new WeakRef(schema);
    })();
    evictEverything();
    // A WeakRef's target stays alive until the current job ends; a file read ends it.
    await NodeFSP.stat(import.meta.filename);
    collect();
    expect(watched.deref()).toBeUndefined();
  });
});

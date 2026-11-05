import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

it("drops JSON noise, merges tagged unions, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("keeps a field description the generator drops on a transformation or Unknown", () => {
  const Trimmed = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((value: string) => value.trim()),
      encode: SchemaGetter.transform((value: string) => value),
    }),
  );
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      script: Trimmed.check(Schema.isMaxLength(10)).annotate({ description: "The script." }),
      graph: Schema.Unknown.annotate({ description: "The graph." }),
      // Optional fields, annotated on the optional wrapper as the orchestrator contracts do.
      args: Schema.optional(Schema.Unknown).annotate({ description: "The args." }),
      note: Schema.optional(Trimmed).annotate({ description: "The note." }),
      plain: Schema.String.annotate({ description: "Kept by the generator." }),
      bare: Schema.String,
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      script: { type: "string", description: "The script." },
      graph: { description: "The graph." },
      args: { description: "The args." },
      note: { type: "string", description: "The note." },
      plain: { type: "string", description: "Kept by the generator." },
      bare: { type: "string" },
    },
    required: ["script", "graph", "plain", "bare"],
  });
});

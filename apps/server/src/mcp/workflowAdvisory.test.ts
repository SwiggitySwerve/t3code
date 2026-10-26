import { describe, expect, it } from "@effect/vitest";

import { graphAdvisory } from "./workflowAdvisory.ts";
import { parseGraph, reviewGraph } from "./workflowGraph.ts";

const node = (overrides: Record<string, unknown> = {}) => ({
  subject: "Task",
  description: "Do the task",
  dependsOn: [],
  ...overrides,
});
const graph = (nodes: Record<string, unknown>) => ({ schemaVersion: 1, nodes });
const advise = (value: unknown) => {
  const review = reviewGraph(value, {});
  const parsed = parseGraph(value);
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return { review, advisory: graphAdvisory(parsed.graph, review.layers) };
};
const chain = (length: number) =>
  graph(
    Object.fromEntries(
      Array.from({ length }, (_, index) => [
        `n${index}`,
        node({ dependsOn: index === 0 ? [] : [`n${index - 1}`] }),
      ]),
    ),
  );
const fanIn = graph({
  a: node(),
  b: node(),
  c: node(),
  combine: node({ dependsOn: ["a", "b", "c"] }),
});

describe("graph advisory", () => {
  it("suggests one agent for a chain, with short reasons", () => {
    const { advisory } = advise(chain(5));
    expect(advisory).toMatchObject({
      fanOut: "consider_single",
      nodeCount: 5,
      widestWave: 1,
      depth: 5,
    });
    expect(advisory.reasons.length).toBeGreaterThan(0);
    expect(advisory.reasons.length).toBeLessThanOrEqual(3);
    for (const reason of advisory.reasons)
      expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(160);
  });

  it("suggests one agent for a lone node and for two unchecked nodes", () => {
    expect(advise(graph({ a: node() })).advisory.fanOut).toBe("consider_single");
    expect(advise(graph({ a: node(), b: node() })).advisory.fanOut).toBe("consider_single");
  });

  it("accepts a fan-out with a combine step and two nodes with a check", () => {
    const { advisory } = advise(fanIn);
    expect(advisory).toMatchObject({
      fanOut: "ok",
      reasons: [],
      nodeCount: 4,
      widestWave: 3,
      depth: 2,
      verifierCount: 0,
    });
    const checked = advise(
      graph({
        a: node(),
        b: node({ verify: { type: "process", argv: ["node", "--version"] } }),
      }),
    ).advisory;
    expect(checked).toMatchObject({ fanOut: "ok", verifierCount: 1 });
  });

  it("estimates calls and tokens including the coordinator, from the measured per-call figures", () => {
    const { advisory } = advise(fanIn);
    // 4 agents x 2-3 calls plus 3-4 coordinator calls; 37k and 96k tokens per call.
    expect(advisory.estimatedModelCalls).toEqual({ low: 11, high: 16 });
    expect(advisory.estimatedTokens).toMatchObject({
      low: 407_000,
      high: 1_536_000,
      coordinator: { low: 111_000, high: 384_000 },
    });
    expect(advisory.estimatedTokens.basis.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(advisory.estimatedTokens.basis, "utf8")).toBeLessThanOrEqual(300);
  });

  it("suggests a budget at 1.4x the worker estimate, which the coordinator's own tokens do not count toward", () => {
    const { advisory } = advise(fanIn);
    expect(advisory.suggestedBudgetTokens).toBe(Math.round(1.4 * (1_536_000 - 384_000)));
    // The widest wave of 3 agents, each 3 calls of 96k tokens, may overshoot a spent budget.
    expect(advisory.overshootBoundTokens).toBe(3 * 3 * 96_000);
  });

  it("counts a judge agent for each judgment check", () => {
    const { advisory } = advise(
      graph({
        a: node({ verify: { type: "judgment", rubric: ["Is it correct?"] } }),
        b: node(),
      }),
    );
    expect(advisory).toMatchObject({ nodeCount: 2, verifierCount: 1, fanOut: "ok" });
    // 3 agents (two workers and one judge): 6-9 calls plus the coordinator's 3-4.
    expect(advisory.estimatedModelCalls).toEqual({ low: 9, high: 13 });
  });

  it("never changes the digest, the blockers or the layers of a review", () => {
    const value = chain(3);
    const review = reviewGraph(value, {});
    expect(review.blockers).toEqual([]);
    expect(review.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(review.layers).toEqual([["n0"], ["n1"], ["n2"]]);
    expect(review.advisory?.fanOut).toBe("consider_single");
  });

  it("gives no advisory for a graph that does not parse", () => {
    const review = reviewGraph(graph({ a: node({ dependsOn: ["missing"] }) }), {});
    expect(review.advisory).toBeUndefined();
    expect(review.digest).toBeNull();
  });
});

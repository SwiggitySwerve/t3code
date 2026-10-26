import { describe, expect, it } from "@effect/vitest";

import { type AdvisoryDrivers, graphAdvisory } from "./workflowAdvisory.ts";
import { parseGraph, reviewGraph } from "./workflowGraph.ts";

const node = (overrides: Record<string, unknown> = {}) => ({
  subject: "Task",
  description: "Do the task",
  dependsOn: [],
  ...overrides,
});
const graph = (nodes: Record<string, unknown>) => ({ schemaVersion: 1, nodes });
const advise = (value: unknown, drivers?: AdvisoryDrivers) => {
  const review = reviewGraph(value, {});
  const parsed = parseGraph(value);
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return { review, advisory: graphAdvisory(parsed.graph, review.layers, drivers) };
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
const driversOf = (
  coordinator: string | undefined,
  nodes: Record<string, string | undefined>,
  judges: Record<string, string | undefined> = {},
): AdvisoryDrivers => ({
  coordinator,
  nodes: new Map(Object.entries(nodes)),
  judges: new Map(Object.entries(judges)),
});
const onCodex = driversOf("codex", { a: "codex", b: "codex", c: "codex", combine: "codex" });
const claudeNodes = {
  a: "claudeAgent",
  b: "claudeAgent",
  c: "claudeAgent",
  combine: "claudeAgent",
};
const onClaude = driversOf("claudeAgent", claudeNodes);
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

  it("estimates a Codex graph from the measured Codex figures", () => {
    const { advisory } = advise(fanIn, onCodex);
    // 4 agents x 2-3 calls of 17k-26k tokens, plus 3-4 coordinator calls of 96k-106k.
    expect(advisory.estimatedModelCalls).toEqual({ low: 11, high: 16 });
    expect(advisory.estimatedTokens).toMatchObject({
      low: 8 * 17_000 + 3 * 96_000,
      high: 12 * 26_000 + 4 * 106_000,
      coordinator: { low: 3 * 96_000, high: 4 * 106_000 },
    });
    expect(advisory.suggestedBudgetTokens).toBe(Math.round(1.4 * 12 * 26_000));
    // The widest wave of 3 agents, each 3 calls of 26k tokens, may overshoot a spent budget.
    expect(advisory.overshootBoundTokens).toBe(3 * 3 * 26_000);
    const { basis } = advisory.estimatedTokens;
    expect(basis).toContain("17k-26k");
    expect(basis).toContain("Measured in C4 on the Codex driver");
    expect(basis).not.toContain("not measured");
    expect(Buffer.byteLength(basis, "utf8")).toBeLessThanOrEqual(300);
  });

  it("keeps the earlier 37k-96k estimate for a Claude graph, which C4 did not measure", () => {
    const { advisory } = advise(fanIn, onClaude);
    expect(advisory.estimatedModelCalls).toEqual({ low: 11, high: 16 });
    expect(advisory.estimatedTokens).toMatchObject({
      low: 11 * 37_000,
      high: 16 * 96_000,
      coordinator: { low: 3 * 37_000, high: 4 * 96_000 },
    });
    // A Claude member's first call alone is near 37k, so a 4-agent fan-in must not be advised
    // a budget below the 12 x 37k its members plausibly spend.
    expect(advisory.suggestedBudgetTokens).toBe(Math.round(1.4 * 12 * 96_000));
    expect(advisory.suggestedBudgetTokens).toBeGreaterThan(12 * 37_000);
    expect(advisory.overshootBoundTokens).toBe(3 * 3 * 96_000);
    const { basis } = advisory.estimatedTokens;
    expect(basis).toContain("37k-96k");
    expect(basis).toContain("Other drivers are not measured");
    expect(basis).not.toContain("Measured in C4");
    expect(Buffer.byteLength(basis, "utf8")).toBeLessThanOrEqual(300);
  });

  it("prices each agent by its own driver in a mixed graph", () => {
    // A Claude coordinator and Claude node a; nodes b, c and combine run on Codex.
    const { advisory } = advise(
      fanIn,
      driversOf("claudeAgent", {
        a: "claudeAgent",
        b: "codex",
        c: "codex",
        combine: "codex",
      }),
    );
    expect(advisory.estimatedTokens).toMatchObject({
      low: 2 * 37_000 + 3 * 2 * 17_000 + 3 * 37_000,
      high: 3 * 96_000 + 3 * 3 * 26_000 + 4 * 96_000,
      coordinator: { low: 3 * 37_000, high: 4 * 96_000 },
    });
    expect(advisory.suggestedBudgetTokens).toBe(Math.round(1.4 * (3 * 96_000 + 3 * 3 * 26_000)));
    // The widest wave is a, b and c at once, so a's 96k figure counts.
    expect(advisory.overshootBoundTokens).toBe(3 * (96_000 + 26_000 + 26_000));
    const { basis } = advisory.estimatedTokens;
    expect(basis).toContain("17k-26k");
    expect(basis).toContain("37k-96k");
    expect(basis).toContain("Measured in C4 on the Codex driver");
    expect(basis).toContain("Other drivers are not measured");
    expect(Buffer.byteLength(basis, "utf8")).toBeLessThanOrEqual(300);
    // A Codex coordinator over Claude members keeps the measured coordinator figure.
    expect(
      advise(fanIn, driversOf("codex", claudeNodes)).advisory.estimatedTokens.coordinator,
    ).toEqual({ low: 3 * 96_000, high: 4 * 106_000 });
  });

  it("treats an unknown driver as unmeasured, never as the cheaper measured figures", () => {
    const { advisory } = advise(fanIn);
    expect(advisory.estimatedTokens).toMatchObject({
      low: 11 * 37_000,
      high: 16 * 96_000,
    });
    expect(advisory.suggestedBudgetTokens).toBe(1_612_800);
    expect(advisory.estimatedTokens.basis).toContain("Other drivers are not measured");
  });

  it("counts a judge agent for each judgment check, on the judge's own driver", () => {
    const value = graph({
      a: node({ verify: { type: "judgment", rubric: ["Is it correct?"] } }),
      b: node(),
    });
    const { advisory } = advise(
      value,
      driversOf("codex", { a: "codex", b: "codex" }, { a: "claudeAgent" }),
    );
    expect(advisory).toMatchObject({ nodeCount: 2, verifierCount: 1, fanOut: "ok" });
    // 3 agents (two workers and one judge): 6-9 calls plus the coordinator's 3-4.
    expect(advisory.estimatedModelCalls).toEqual({ low: 9, high: 13 });
    // The judge is the only Claude agent; the two workers are on Codex.
    expect(advisory.estimatedTokens).toMatchObject({
      low: 2 * 2 * 17_000 + 2 * 37_000 + 3 * 96_000,
      high: 2 * 3 * 26_000 + 3 * 96_000 + 4 * 106_000,
    });
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

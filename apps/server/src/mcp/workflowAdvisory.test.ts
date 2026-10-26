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
    // 12 agent calls, one more attempt of the costliest agent (3 calls), and the coordinator as reserve.
    expect(advisory.suggestedBudgetTokens).toBe(
      Math.round(1.4 * (12 * 26_000 + 3 * 26_000)) + 4 * 106_000,
    );
    // The widest wave of 3 agents, each 3 calls of 26k tokens, may overshoot a spent budget.
    expect(advisory.overshootBoundTokens).toBe(3 * 3 * 26_000);
    const { basis } = advisory.estimatedTokens;
    expect(basis).toContain("17k-26k");
    expect(basis).toContain("Measured in C4 on the Codex driver");
    expect(basis).not.toContain("not measured");
    expect(Buffer.byteLength(basis, "utf8")).toBeLessThanOrEqual(360);
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
    expect(advisory.suggestedBudgetTokens).toBe(
      Math.round(1.4 * (12 * 96_000 + 3 * 96_000)) + 4 * 96_000,
    );
    expect(advisory.suggestedBudgetTokens).toBeGreaterThan(12 * 37_000);
    expect(advisory.overshootBoundTokens).toBe(3 * 3 * 96_000);
    const { basis } = advisory.estimatedTokens;
    expect(basis).toContain("37k-96k");
    expect(basis).toContain("Other drivers are not measured");
    expect(basis).not.toContain("Measured in C4");
    expect(Buffer.byteLength(basis, "utf8")).toBeLessThanOrEqual(360);
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
    expect(advisory.suggestedBudgetTokens).toBe(
      Math.round(1.4 * (3 * 96_000 + 3 * 3 * 26_000 + 3 * 96_000)) + 4 * 96_000,
    );
    // The widest wave is a, b and c at once, so a's 96k figure counts.
    expect(advisory.overshootBoundTokens).toBe(3 * (96_000 + 26_000 + 26_000));
    const { basis } = advisory.estimatedTokens;
    expect(basis).toContain("17k-26k");
    expect(basis).toContain("37k-96k");
    expect(basis).toContain("Measured in C4 on the Codex driver");
    expect(basis).toContain("Other drivers are not measured");
    expect(Buffer.byteLength(basis, "utf8")).toBeLessThanOrEqual(360);
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
    expect(advisory.suggestedBudgetTokens).toBe(2_400_000);
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

/**
 * G5 of review 7: six extract nodes that each read ten ~4.7 KB runbooks, one merge node that reads
 * their twelve outputs and carries a judgment check. Its members recorded 1,451,543 tokens across
 * the six extract nodes before the merge node was asked to start.
 */
describe("graph advisory budget for a read-heavy fan-in (review 7, G5)", () => {
  const RUNBOOK_BYTES = 4_707;
  const RECORDED_BEFORE_MERGE = 1_451_543;
  const OLD_SUGGESTION = Math.round(1.4 * 8 * 3 * 26_000);
  const extractKeys = Array.from({ length: 6 }, (_, index) => `extract-${index + 1}`);
  const runbook = (n: number) => `runbooks/rb-${String(n).padStart(3, "0")}.md`;
  const g5 = graph({
    ...Object.fromEntries(
      extractKeys.map((key, index) => [
        key,
        node({
          inputs: Array.from({ length: 10 }, (_, file) => ({
            id: `rb${file + 1}`,
            kind: "workspace_snapshot",
            path: runbook(index * 10 + file + 1),
          })),
          outputs: [{ id: "part", path: `out/g5/parts/part-${index + 1}.json` }],
        }),
      ]),
    ),
    merge: node({
      dependsOn: extractKeys,
      inputs: extractKeys.map((key) => ({
        id: `p-${key}`,
        kind: "task_output",
        nodeId: key,
        outputId: "part",
      })),
      outputs: [{ id: "table", path: "out/g5/table.json" }],
      verify: { type: "judgment", rubric: ["Is the table complete?"] },
    }),
  });
  const hashes = Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [
      runbook(index + 1),
      { sha256: "a".repeat(64), sizeBytes: RUNBOOK_BYTES },
    ]),
  );
  const onCodex = driversOf(
    "codex",
    Object.fromEntries([...extractKeys, "merge"].map((key) => [key, "codex"])),
    { merge: "codex" },
  );
  const review = reviewGraph(g5, hashes, onCodex);

  it("reproduces the shape: the old suggestion is spent before the merge node can start", () => {
    expect(review.blockers).toEqual([]);
    expect(review.layers.map((layer) => layer.length)).toEqual([6, 1]);
    // graph_start refused the merge node once the recorded tokens reached the budget.
    expect(OLD_SUGGESTION).toBe(873_600);
    expect(RECORDED_BEFORE_MERGE).toBeGreaterThanOrEqual(OLD_SUGGESTION);
  });

  it("suggests a budget the merge node can still start under", () => {
    const { suggestedBudgetTokens, estimatedTokens, overshootBoundTokens } = review.advisory!;
    expect(suggestedBudgetTokens).toBeGreaterThan(RECORDED_BEFORE_MERGE);
    // The estimate is a ceiling, not a licence: it stays within about twice what the members used.
    expect(suggestedBudgetTokens).toBeLessThan(3 * RECORDED_BEFORE_MERGE);
    // The six extract nodes at once are the widest wave, and the bound covers what they recorded.
    expect(overshootBoundTokens).toBeGreaterThan(RECORDED_BEFORE_MERGE);
    expect(estimatedTokens.high).toBeGreaterThan(RECORDED_BEFORE_MERGE);
    expect(estimatedTokens.basis).toContain("Estimates");
  });

  it("scales a node's estimate with the bytes it reads", () => {
    const small = Object.fromEntries(
      Object.entries(hashes).map(([path, hash]) => [path, { ...hash, sizeBytes: 100 }]),
    );
    const lean = reviewGraph(g5, small, onCodex).advisory!;
    expect(lean.estimatedTokens.high).toBeLessThan(review.advisory!.estimatedTokens.high);
    expect(lean.suggestedBudgetTokens).toBeLessThan(review.advisory!.suggestedBudgetTokens);
  });

  it("does not starve the last node when a retry doubles the costliest earlier node", () => {
    const costliestExtract = 360_511;
    expect(review.advisory!.suggestedBudgetTokens).toBeGreaterThan(
      RECORDED_BEFORE_MERGE + costliestExtract,
    );
  });
});

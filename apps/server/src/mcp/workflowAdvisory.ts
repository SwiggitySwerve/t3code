import type { OrchestratorMcpGraphAdvisory } from "@t3tools/contracts";

/**
 * graph_review advisory calibration: call counts and the 96k high figure are from C1 (qa/iter4/C1,
 * 2026-10-26); the 37k low figure is M7's Claude prefix. Headroom and thresholds are opinion.
 * Re-measure at C4 and update these.
 */
const CALLS_PER_AGENT = { low: 2, high: 3 } as const;
const COORDINATOR_CALLS = { low: 3, high: 4 } as const;
const TOKENS_PER_CALL = { low: 37_000, high: 96_000 } as const;
const BUDGET_HEADROOM = 1.4;
const BASIS =
  "Per agent 2-3 model calls, coordinator 3-4, 37k-96k tokens per call (calls and 96k measured in C1, 37k in M7); headroom and thresholds are opinion until C4.";

/** The parts of a parsed graph the advisory reads; workflowGraph.ts passes its own types. */
interface AdvisoryGraph {
  readonly nodes: Readonly<Record<string, { readonly verify?: { readonly type: string } }>>;
}

const singleAgentReasons = (input: {
  readonly nodeCount: number;
  readonly widestWave: number;
  readonly verifierCount: number;
}): ReadonlyArray<string> => {
  if (input.nodeCount === 1) {
    return [
      "A single node gains nothing from a graph; one agent does the same work with less overhead.",
    ];
  }
  if (input.widestWave <= 1) {
    return [
      "Every node waits for the one before it, so nothing runs in parallel; one agent avoids a full context prefix per node.",
    ];
  }
  if (input.nodeCount <= 2 && input.verifierCount === 0) {
    return ["Two nodes and no independent check; one agent covers this with less overhead."];
  }
  return [];
};

/** Advice for a reviewed graph. It reads the graph and never feeds the digest, blockers or readiness. */
export function graphAdvisory(
  graph: AdvisoryGraph,
  layers: ReadonlyArray<ReadonlyArray<string>>,
): OrchestratorMcpGraphAdvisory {
  const nodes = Object.values(graph.nodes);
  const nodeCount = nodes.length;
  const widestWave = Math.max(0, ...layers.map((layer) => layer.length));
  const verifierCount = nodes.filter((node) => node.verify !== undefined).length;
  // A judgment check runs as one more agent.
  const agents = nodeCount + nodes.filter((node) => node.verify?.type === "judgment").length;
  const calls = {
    low: agents * CALLS_PER_AGENT.low + COORDINATOR_CALLS.low,
    high: agents * CALLS_PER_AGENT.high + COORDINATOR_CALLS.high,
  };
  const coordinator = {
    low: COORDINATOR_CALLS.low * TOKENS_PER_CALL.low,
    high: COORDINATOR_CALLS.high * TOKENS_PER_CALL.high,
  };
  const tokensHigh = calls.high * TOKENS_PER_CALL.high;
  const reasons = singleAgentReasons({ nodeCount, widestWave, verifierCount });
  return {
    fanOut: reasons.length > 0 ? "consider_single" : "ok",
    reasons,
    nodeCount,
    widestWave,
    depth: layers.length,
    verifierCount,
    estimatedModelCalls: calls,
    estimatedTokens: {
      low: calls.low * TOKENS_PER_CALL.low,
      high: tokensHigh,
      coordinator,
      basis: BASIS,
    },
    // budgetTokens counts finished agents only, so the coordinator's share is left out.
    suggestedBudgetTokens: Math.round(BUDGET_HEADROOM * (tokensHigh - coordinator.high)),
    overshootBoundTokens: widestWave * CALLS_PER_AGENT.high * TOKENS_PER_CALL.high,
  };
}

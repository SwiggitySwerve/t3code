import type { OrchestratorMcpGraphAdvisory } from "@t3tools/contracts";

/**
 * graph_review advisory calibration. Token figures per call depend on the provider driver. C4
 * (qa/iter4/C4, 2026-10-26) measured the Codex driver with Sonnet 5.5 through cliproxy; every other
 * driver, Claude included, keeps the earlier 37k-96k estimate until measured. Headroom is opinion.
 */
const CALLS_PER_AGENT = { low: 2, high: 3 } as const;
const COORDINATOR_CALLS = { low: 3, high: 4 } as const;
const MEASURED_DRIVER = "codex";
interface CallFigure {
  readonly low: number;
  readonly high: number;
  /** How the figure is labelled in the basis. */
  readonly label: string;
}
interface DriverFigures {
  readonly member: CallFigure;
  readonly coordinator: CallFigure;
  readonly measured: boolean;
}
const MEASURED_FIGURES: DriverFigures = {
  member: { low: 17_000, high: 26_000, label: "Codex" },
  coordinator: { low: 96_000, high: 106_000, label: "Codex" },
  measured: true,
};
const UNMEASURED_FIGURES: DriverFigures = {
  member: { low: 37_000, high: 96_000, label: "other drivers" },
  coordinator: { low: 37_000, high: 96_000, label: "other drivers" },
  measured: false,
};
/** An unknown driver gets the larger, unmeasured figures, so the advice never under-reports. */
const figuresFor = (driver: string | undefined): DriverFigures =>
  driver === MEASURED_DRIVER ? MEASURED_FIGURES : UNMEASURED_FIGURES;
const BUDGET_HEADROOM = 1.4;

/** The provider driver that runs each agent of a reviewed graph. A missing entry is unknown. */
export interface AdvisoryDrivers {
  readonly coordinator: string | undefined;
  /** Each node's agent, by node id. */
  readonly nodes: ReadonlyMap<string, string | undefined>;
  /** Each judgment check's judge agent, by node id. */
  readonly judges: ReadonlyMap<string, string | undefined>;
}

/** The parts of a parsed graph the advisory reads; workflowGraph.ts passes its own types. */
interface AdvisoryGraph {
  readonly nodes: Readonly<Record<string, { readonly verify?: { readonly type: string } }>>;
}

const kTokens = (tokens: number) => `${tokens / 1000}k`;
const rangeText = (figure: CallFigure) =>
  `${kTokens(figure.low)}-${kTokens(figure.high)} (${figure.label})`;
const rangesText = (figures: ReadonlyArray<CallFigure>) =>
  [...new Set(figures)].map(rangeText).join(" or ");

const basisFor = (members: ReadonlyArray<DriverFigures>, coordinator: DriverFigures): string => {
  const all = [...members, coordinator];
  const notes = [
    all.some((figures) => figures.measured)
      ? "Measured in C4 on the Codex driver (Sonnet 5.5 via cliproxy)."
      : "",
    all.some((figures) => !figures.measured)
      ? "Other drivers are not measured; their figures are the earlier estimate."
      : "",
    "Headroom is opinion.",
  ].filter((note) => note !== "");
  return `Per agent 2-3 model calls of ${rangesText(members.map((figures) => figures.member))} tokens, coordinator 3-4 of ${rangeText(coordinator.coordinator)} tokens. ${notes.join(" ")}`;
};

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
  drivers?: AdvisoryDrivers,
): OrchestratorMcpGraphAdvisory {
  const entries = Object.entries(graph.nodes);
  const nodeCount = entries.length;
  const widestWave = Math.max(0, ...layers.map((layer) => layer.length));
  const verifierCount = entries.filter(([, node]) => node.verify !== undefined).length;
  const nodeFigures = (id: string) => figuresFor(drivers?.nodes.get(id));
  // A judgment check runs as one more agent, on its own driver.
  const memberFigures = entries.flatMap(([id, node]) => [
    nodeFigures(id),
    ...(node.verify?.type === "judgment" ? [figuresFor(drivers?.judges.get(id))] : []),
  ]);
  const coordinatorFigures = figuresFor(drivers?.coordinator);
  const agents = memberFigures.length;
  const calls = {
    low: agents * CALLS_PER_AGENT.low + COORDINATOR_CALLS.low,
    high: agents * CALLS_PER_AGENT.high + COORDINATOR_CALLS.high,
  };
  const members = {
    low: CALLS_PER_AGENT.low * memberFigures.reduce((sum, f) => sum + f.member.low, 0),
    high: CALLS_PER_AGENT.high * memberFigures.reduce((sum, f) => sum + f.member.high, 0),
  };
  const coordinator = {
    low: COORDINATOR_CALLS.low * coordinatorFigures.coordinator.low,
    high: COORDINATOR_CALLS.high * coordinatorFigures.coordinator.high,
  };
  // Agents already running finish after the budget is spent, so the widest wave bounds the overshoot.
  const overshootBoundTokens = Math.max(
    0,
    ...layers.map(
      (layer) =>
        CALLS_PER_AGENT.high * layer.reduce((sum, id) => sum + nodeFigures(id).member.high, 0),
    ),
  );
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
      low: members.low + coordinator.low,
      high: members.high + coordinator.high,
      coordinator,
      basis: basisFor(memberFigures, coordinatorFigures),
    },
    // budgetTokens counts finished agents only, so the coordinator's share is left out.
    suggestedBudgetTokens: Math.round(BUDGET_HEADROOM * members.high),
    overshootBoundTokens,
  };
}

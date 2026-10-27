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
/**
 * A node that reads files makes more calls, and every later call carries what was read. Review 7 (G5)
 * recorded 4-9 calls (mean 6.5) and 132k-348k tokens for each of six nodes that read ten 4.7 KB files,
 * against C4's 2-3 calls of 17k-26k for nodes that read one or two small files. These are estimates.
 */
const INPUTS_PER_EXTRA_CALL = { low: 5, high: 3 } as const;
const BYTES_PER_TOKEN = 4;

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
  readonly nodes: Readonly<
    Record<
      string,
      {
        readonly verify?: { readonly type: string };
        readonly inputs?: ReadonlyArray<{ readonly kind: string; readonly path?: string }>;
      }
    >
  >;
}

/** What review hashed for each input path; a missing or oversize file has no size to read. */
export type AdvisoryInputSizes = Readonly<
  Record<string, { readonly sizeBytes: number } | "missing" | "too_large">
>;

interface AgentLoad {
  readonly calls: { readonly low: number; readonly high: number };
  readonly tokens: { readonly low: number; readonly high: number };
}

/** One agent's calls and tokens: C4's per-call figures plus the reads its inputs add. */
const agentLoad = (
  figures: DriverFigures,
  reads: { readonly count: number; readonly bytes: number },
): AgentLoad => {
  const readTokens = Math.ceil(reads.bytes / BYTES_PER_TOKEN);
  const calls = {
    low: CALLS_PER_AGENT.low + Math.floor(reads.count / INPUTS_PER_EXTRA_CALL.low),
    high: CALLS_PER_AGENT.high + Math.ceil(reads.count / INPUTS_PER_EXTRA_CALL.high),
  };
  return {
    calls,
    tokens: {
      low: calls.low * (figures.member.low + Math.floor(readTokens / 2)),
      high: calls.high * (figures.member.high + readTokens),
    },
  };
};

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
    "Estimates: each 3 inputs add a call, input bytes/4 add tokens per call. Headroom is opinion.",
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
  inputSizes: AdvisoryInputSizes = {},
): OrchestratorMcpGraphAdvisory {
  const entries = Object.entries(graph.nodes);
  const nodeCount = entries.length;
  const widestWave = Math.max(0, ...layers.map((layer) => layer.length));
  const verifierCount = entries.filter(([, node]) => node.verify !== undefined).length;
  const nodeFigures = (id: string) => figuresFor(drivers?.nodes.get(id));
  const readsOf = (inputs: NonNullable<AdvisoryGraph["nodes"][string]["inputs"]>) => ({
    count: inputs.length,
    bytes: inputs.reduce((sum, input) => {
      const size = input.path === undefined ? undefined : inputSizes[input.path];
      return typeof size === "object" ? sum + size.sizeBytes : sum;
    }, 0),
  });
  const nodeLoads = new Map(
    entries.map(([id, node]) => [id, agentLoad(nodeFigures(id), readsOf(node.inputs ?? []))]),
  );
  // A judgment check runs as one more agent, on its own driver, and reads nothing but the result.
  const judgeFigures = entries.flatMap(([id, node]) =>
    node.verify?.type === "judgment" ? [figuresFor(drivers?.judges.get(id))] : [],
  );
  const memberFigures = [...entries.map(([id]) => nodeFigures(id)), ...judgeFigures];
  const loads = [
    ...nodeLoads.values(),
    ...judgeFigures.map((figures) => agentLoad(figures, { count: 0, bytes: 0 })),
  ];
  const coordinatorFigures = figuresFor(drivers?.coordinator);
  const calls = {
    low: loads.reduce((sum, load) => sum + load.calls.low, 0) + COORDINATOR_CALLS.low,
    high: loads.reduce((sum, load) => sum + load.calls.high, 0) + COORDINATOR_CALLS.high,
  };
  const members = {
    low: loads.reduce((sum, load) => sum + load.tokens.low, 0),
    high: loads.reduce((sum, load) => sum + load.tokens.high, 0),
  };
  const coordinator = {
    low: COORDINATOR_CALLS.low * coordinatorFigures.coordinator.low,
    high: COORDINATOR_CALLS.high * coordinatorFigures.coordinator.high,
  };
  // Agents already running finish after the budget is spent, so the widest wave bounds the overshoot.
  const overshootBoundTokens = Math.max(
    0,
    ...layers.map((layer) =>
      layer.reduce((sum, id) => sum + (nodeLoads.get(id)?.tokens.high ?? 0), 0),
    ),
  );
  // The budget only stops new starts, so the last node is the one a short budget drops. Cover every
  // agent, one retry of the costliest (C4/S06: a retried node costs one more attempt), and the
  // coordinator's estimate as reserve (the budget does not count it).
  const retryTokens = Math.max(0, ...loads.map((load) => load.tokens.high));
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
    suggestedBudgetTokens:
      Math.round(BUDGET_HEADROOM * (members.high + retryTokens)) + coordinator.high,
    overshootBoundTokens,
  };
}

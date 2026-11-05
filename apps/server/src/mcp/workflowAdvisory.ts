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
  /** Each node's declared retry targets, in order, by node id. */
  readonly retries?: ReadonlyMap<string, ReadonlyArray<string | undefined>>;
}

/** The parts of a parsed graph the advisory reads; workflowGraph.ts passes its own types. */
interface AdvisoryGraph {
  readonly nodes: Readonly<
    Record<
      string,
      {
        readonly verify?: { readonly type: string };
        readonly inputs?: ReadonlyArray<{ readonly kind: string; readonly path?: string }>;
        readonly retries?: ReadonlyArray<unknown>;
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

const basisFor = (
  members: ReadonlyArray<DriverFigures>,
  coordinator: DriverFigures,
  retried: boolean,
): string => {
  const all = [...members, coordinator];
  const notes = [
    retried ? "High counts every declared retry target, and its judge." : "",
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
  const judgeFigures = new Map(
    entries.flatMap(([id, node]) =>
      node.verify?.type === "judgment" ? [[id, figuresFor(drivers?.judges.get(id))] as const] : [],
    ),
  );
  const judgeLoads = new Map(
    [...judgeFigures].map(([id, figures]) => [id, agentLoad(figures, { count: 0, bytes: 0 })]),
  );
  // A declared retry target is an attempt the high estimate counts, on its own driver with the
  // node's reads, and judged again when the node has a judgment check.
  const retryFigures = entries.flatMap(([id, node]) =>
    (node.retries ?? []).map((_, index) => ({
      id,
      node,
      figures: figuresFor(drivers?.retries?.get(id)?.[index]),
    })),
  );
  const judgeLoadOf = (id: string): ReadonlyArray<AgentLoad> => {
    const load = judgeLoads.get(id);
    return load === undefined ? [] : [load];
  };
  const retryLoads = retryFigures.flatMap(({ id, node, figures }) => [
    agentLoad(figures, readsOf(node.inputs ?? [])),
    ...judgeLoadOf(id),
  ]);
  const memberFigures = [
    ...entries.map(([id]) => nodeFigures(id)),
    ...judgeFigures.values(),
    ...retryFigures.map((entry) => entry.figures),
  ];
  const loads = [...nodeLoads.values(), ...judgeLoads.values()];
  const retriedHigh = {
    calls: retryLoads.reduce((sum, load) => sum + load.calls.high, 0),
    tokens: retryLoads.reduce((sum, load) => sum + load.tokens.high, 0),
  };
  const coordinatorFigures = figuresFor(drivers?.coordinator);
  const calls = {
    low: loads.reduce((sum, load) => sum + load.calls.low, 0) + COORDINATOR_CALLS.low,
    high:
      loads.reduce((sum, load) => sum + load.calls.high, 0) +
      retriedHigh.calls +
      COORDINATOR_CALLS.high,
  };
  const members = {
    low: loads.reduce((sum, load) => sum + load.tokens.low, 0),
    high: loads.reduce((sum, load) => sum + load.tokens.high, 0) + retriedHigh.tokens,
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
  // coordinator's estimate as reserve (the budget does not count it). A node that declares its
  // retries has them in members.high already, so only the others can take that one retry.
  const retryTokens = Math.max(
    0,
    ...entries.flatMap(([id, node]) =>
      node.retries === undefined
        ? [nodeLoads.get(id)?.tokens.high ?? 0, ...judgeLoadOf(id).map((load) => load.tokens.high)]
        : [],
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
      basis: basisFor(memberFigures, coordinatorFigures, retryFigures.length > 0),
    },
    suggestedBudgetTokens:
      Math.round(BUDGET_HEADROOM * (members.high + retryTokens)) + coordinator.high,
    overshootBoundTokens,
  };
}

// Claude Code accepts its family's bare aliases as model ids.
const CLAUDE_ALIASES: ReadonlySet<string> = new Set(["opus", "sonnet", "haiku", "fable"]);
// Vendor, router and region segments some catalogs put before a model's own name.
const MODEL_ID_PREFIXES: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "meta",
  "mistral",
  "openrouter",
  "bedrock",
  "vertex",
  "azure",
  "us",
  "eu",
  "apac",
  "global",
]);
// Ids that name a router's choice or a default rather than one model.
const PLACEHOLDER_MODELS: ReadonlySet<string> = new Set(["auto", "default"]);

/** The model's own name: the first `/` or `.` segment that is not a vendor or region. */
function modelName(model: string): string {
  const segments = model
    .trim()
    .toLowerCase()
    .split(/[/.]/u)
    .filter((segment) => segment.length > 0);
  return segments.find((segment) => !MODEL_ID_PREFIXES.has(segment)) ?? segments.at(-1) ?? "";
}

/**
 * A model id's family: the leading letters of its own name, so "gpt-5.4", "o3" and "o4-mini"
 * are "gpt" and "us.anthropic.claude-x" and "anthropic/claude-x" "claude". Advice reads it, and
 * so does the rule that retries leaving a family need a judgment check with its own target.
 */
export function modelFamily(model: string): string {
  const name = modelName(model);
  if (/^o\d/u.test(name)) return "gpt";
  const family = /^[a-z]+/u.exec(name)?.[0] ?? name;
  return CLAUDE_ALIASES.has(family) ? "claude" : family;
}

/** The family of a model a coordinator can target; undefined for a placeholder such as "auto". */
export function concreteModelFamily(model: string): string | undefined {
  return PLACEHOLDER_MODELS.has(modelName(model)) ? undefined : modelFamily(model) || undefined;
}

/** One reviewed node's assignment, as graph review resolved it. */
export interface AssignmentReview {
  readonly nodeId: string;
  /** "caller" means the node set no target and runs on the coordinator's model. */
  readonly source: string;
  readonly model: string;
  /** The models of its declared retry targets, in order. */
  readonly retryModels?: ReadonlyArray<string>;
  /** Present for a judgment check; `ownTarget` is false when it inherits the worker's. */
  readonly judgment?: { readonly model: string; readonly ownTarget: boolean };
}

/**
 * Notes on how a graph assigns models: a worker or judgment check that falls back to the
 * coordinator's own model, and a judgment check of the family of its worker or of one of its
 * retry targets while a model of another family is enabled. Advice only; it never feeds the
 * digest or readiness.
 */
export function graphAssignmentNotes(input: {
  readonly coordinatorModel: string;
  readonly nodes: ReadonlyArray<AssignmentReview>;
  readonly enabledFamilies: ReadonlySet<string>;
}): ReadonlyArray<string> {
  const own = `your own model (${input.coordinatorModel})`;
  return input.nodes.flatMap((node) => {
    const notes: string[] = [];
    if (node.source === "caller") notes.push(`${node.nodeId}: no target, so it runs on ${own}.`);
    const judgment = node.judgment;
    if (judgment === undefined) return notes;
    if (!judgment.ownTarget && node.source === "caller") {
      notes.push(`${node.nodeId} judgment: no target, so it runs on ${own}.`);
      return notes;
    }
    const family = modelFamily(node.model);
    const otherEnabled = [...input.enabledFamilies].some((enabled) => enabled !== family);
    const judgeFamily = modelFamily(judgment.model);
    if (judgeFamily === family && otherEnabled) {
      notes.push(
        `${node.nodeId} judgment: same model family as its worker (${family}) while another family is enabled.`,
      );
    }
    const otherThanJudge = [...input.enabledFamilies].some((enabled) => enabled !== judgeFamily);
    (node.retryModels ?? []).forEach((model, index) => {
      if (modelFamily(model) === judgeFamily && otherThanJudge)
        notes.push(
          `${node.nodeId} retries[${index}]: same model family as its judgment check (${judgeFamily}) while another family is enabled.`,
        );
    });
    return notes;
  });
}

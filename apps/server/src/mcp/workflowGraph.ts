// @effect-diagnostics nodeBuiltinImport:off -- graph review hashes pure, normalized values synchronously.
import * as NodeCrypto from "node:crypto";

import type { OrchestrationV2WorkflowPlan } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { workflowGraphFailureSummary } from "@t3tools/shared/workflowGraphResult";

import { type AdvisoryDrivers, graphAdvisory } from "./workflowAdvisory.ts";
import {
  FILE_ID,
  type FileRef,
  type FileScopes,
  parseCheck,
  parseFileRefs,
  parseScopes,
  scopesOverlap,
  type WorkflowCheck,
} from "./workflowChecks.ts";
import { MAX_AGENT_ATTEMPTS, MAX_AGENTS_PER_WORKFLOW, maxAgentsPerCall } from "./workflowLimits.ts";

type AttemptBudget = "short" | "standard" | "long";
const ATTEMPT_BUDGETS = { short: 30 * 60_000, standard: 2 * 60 * 60_000, long: 6 * 60 * 60_000 };

export function attemptBudgetMs(budget: AttemptBudget = "standard"): number {
  return ATTEMPT_BUDGETS[budget];
}

type GraphInput =
  | (Omit<FileRef, "sha256"> & { readonly kind: "workspace_snapshot" })
  | {
      readonly id: string;
      readonly kind: "task_output";
      readonly nodeId: string;
      readonly outputId: string;
    };

interface GraphNode {
  readonly subject: string;
  readonly description: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly phase?: string;
  readonly target?: unknown;
  readonly model?: string;
  readonly preset?: string;
  readonly role?: string;
  readonly schema?: unknown;
  readonly scopes?: FileScopes;
  readonly inputs: ReadonlyArray<GraphInput>;
  readonly outputs: ReadonlyArray<Omit<FileRef, "sha256">>;
  readonly verify?: WorkflowCheck;
  readonly attemptBudget: AttemptBudget;
  readonly longBudgetApproved?: true;
  readonly stallTimeoutMs?: number;
}

export interface WorkflowGraph {
  readonly schemaVersion: 1;
  readonly name?: string;
  readonly nodes: Readonly<Record<string, GraphNode>>;
}

type InputHash = { readonly sha256: string; readonly sizeBytes: number } | "missing" | "too_large";
type ParseResult =
  | { readonly ok: true; readonly graph: WorkflowGraph }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function id(value: unknown, what: string): string {
  if (typeof value !== "string" || !FILE_ID.test(value)) {
    throw new Error(
      what +
        " needs an id of 1-64 letters, digits, dot, dash or underscore, starting with a letter or digit.",
    );
  }
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(what + " must be a non-empty string.");
  return value.trim();
}

function parseInputs(value: unknown): ReadonlyArray<GraphInput> {
  if (!Array.isArray(value)) throw new Error("inputs must be an array.");
  // Task output paths are resolved from the producer; the file parser still owns all input ids and limits.
  const refs = parseFileRefs(
    value.map((entry) => {
      const input = record(entry);
      return input?.kind === "task_output" ? { id: input.id, path: "." } : entry;
    }),
    "inputs",
  );
  return value.map((entry, index): GraphInput => {
    const input = record(entry);
    const ref = refs[index];
    if (ref === undefined) throw new Error("input could not be parsed.");
    if (input?.kind === "workspace_snapshot") {
      return { id: ref.id, path: ref.path, maxBytes: ref.maxBytes, kind: "workspace_snapshot" };
    }
    if (input?.kind === "task_output") {
      return {
        id: ref.id,
        kind: "task_output",
        nodeId: id(input.nodeId, "input.nodeId"),
        outputId: id(input.outputId, "input.outputId"),
      };
    }
    throw new Error('input.kind must be "workspace_snapshot" or "task_output".');
  });
}

type NodeParse = { readonly node: GraphNode } | { readonly problems: ReadonlyArray<string> };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Runs one field's parser. A problem is recorded and the node's other fields are still read. */
function field<T>(problems: string[], parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    problems.push(messageOf(error));
    return undefined;
  }
}

/**
 * A file list the way `parseAll` reads it. When it fails, each bad entry gets its own problem
 * where the list parser would name only the first.
 */
function fileList<T>(
  problems: string[],
  value: unknown,
  what: "inputs" | "outputs",
  parseAll: () => T,
  parseOne: (entry: unknown) => unknown,
): T | undefined {
  try {
    return parseAll();
  } catch (error) {
    const found = (Array.isArray(value) ? value : []).flatMap((entry, index) => {
      try {
        parseOne(entry);
        return [];
      } catch (cause) {
        const message = messageOf(cause);
        if (message.startsWith(`${what}[0]`))
          return [message.replace(`${what}[0]`, `${what}[${index}]`)];
        return [message.startsWith(`${what}.`) ? message : `${what}[${index}]: ${message}`];
      }
    });
    problems.push(...(found.length > 0 ? found : [messageOf(error)]));
    return undefined;
  }
}

/** Reads every field of a node, so one review reports all its problems. */
function parseNode(value: unknown): NodeParse {
  const node = record(value);
  if (node === undefined) return { problems: ["node must be an object."] };
  const problems: string[] = [];
  const optional = <T>(raw: unknown, parse: (raw: unknown) => T): T | undefined =>
    raw === undefined ? undefined : field(problems, () => parse(raw));
  const dependsOn = field(problems, () => {
    if (!Array.isArray(node.dependsOn)) throw new Error("dependsOn must be an array of node ids.");
    return [...new Set(node.dependsOn.map((entry) => id(entry, "dependsOn")))].sort();
  });
  const attemptBudget = field(problems, (): AttemptBudget => {
    const budget = node.attemptBudget ?? "standard";
    if (budget !== "short" && budget !== "standard" && budget !== "long")
      throw new Error('attemptBudget must be "short", "standard" or "long".');
    if (node.longBudgetApproved !== undefined && node.longBudgetApproved !== true)
      throw new Error("longBudgetApproved must be true when supplied.");
    if (budget === "long" && node.longBudgetApproved !== true)
      throw new Error('attemptBudget "long" requires longBudgetApproved: true.');
    return budget;
  });
  const stallTimeoutMs = optional(node.stallTimeoutMs, (raw) => {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1)
      throw new Error("stallTimeoutMs must be a positive whole number.");
    return raw;
  });
  const outputs = fileList(
    problems,
    node.outputs ?? [],
    "outputs",
    () =>
      parseFileRefs(node.outputs ?? [], "outputs").map(({ id, path, maxBytes }) => ({
        id,
        path,
        maxBytes,
      })),
    (entry) => parseFileRefs([entry], "outputs"),
  );
  const verify = optional(node.verify, parseCheck);
  if (
    outputs !== undefined &&
    verify?.type === "structured" &&
    verify.outputId !== undefined &&
    !outputs.some((output) => output.id === verify.outputId)
  )
    problems.push("verify.outputId names an undeclared output: " + verify.outputId);
  const subject = field(problems, () => text(node.subject, "subject"));
  const description = field(problems, () => text(node.description, "description"));
  const phase = optional(node.phase, (raw) => text(raw, "phase"));
  const model = optional(node.model, (raw) => text(raw, "model"));
  const preset = optional(node.preset, (raw) => text(raw, "preset"));
  const role = optional(node.role, (raw) => text(raw, "role"));
  const scopes = optional(node.scopes, parseScopes);
  const inputs = fileList(
    problems,
    node.inputs ?? [],
    "inputs",
    () => parseInputs(node.inputs ?? []),
    (entry) => parseInputs([entry]),
  );
  if (
    problems.length > 0 ||
    dependsOn === undefined ||
    attemptBudget === undefined ||
    outputs === undefined ||
    inputs === undefined ||
    subject === undefined ||
    description === undefined
  )
    return { problems };
  return {
    node: {
      subject,
      description,
      dependsOn,
      ...(phase === undefined ? {} : { phase }),
      ...(node.target === undefined ? {} : { target: node.target }),
      ...(model === undefined ? {} : { model }),
      ...(preset === undefined ? {} : { preset }),
      ...(role === undefined ? {} : { role }),
      ...(node.schema === undefined ? {} : { schema: node.schema }),
      ...(scopes === undefined ? {} : { scopes }),
      inputs,
      outputs,
      ...(verify === undefined ? {} : { verify }),
      attemptBudget,
      ...(node.longBudgetApproved === true ? { longBudgetApproved: true } : {}),
      ...(stallTimeoutMs === undefined ? {} : { stallTimeoutMs }),
    },
  };
}
function graphLayers(graph: WorkflowGraph): string[][] {
  const remaining = new Set(Object.keys(graph.nodes).sort());
  const done = new Set<string>();
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((key) =>
      graph.nodes[key]?.dependsOn.every((dep) => done.has(dep)),
    );
    if (ready.length === 0) break;
    layers.push(ready);
    for (const key of ready) {
      remaining.delete(key);
      done.add(key);
    }
  }
  return layers;
}

/** The graph as the app shows it: each node's label, wave and dependencies, without prompts. */
export function graphPlan(graph: WorkflowGraph): OrchestrationV2WorkflowPlan {
  return {
    nodes: graphLayers(graph).flatMap((layer, wave) =>
      layer.map((key) => {
        const node = graph.nodes[key]!;
        return { key, label: node.subject, wave, dependsOn: [...node.dependsOn] };
      }),
    ),
  };
}

export function parseGraph(value: unknown): ParseResult {
  const source = record(value);
  if (source === undefined) return { ok: false, problems: ["graph must be an object."] };
  const problems: string[] = [];
  if (source.schemaVersion !== 1) problems.push("schemaVersion must be 1.");
  const rawNodes = record(source.nodes);
  const nodeKeys = rawNodes === undefined ? [] : Object.keys(rawNodes);
  if (rawNodes === undefined || nodeKeys.length === 0)
    return {
      ok: false,
      problems: [...problems, "nodes must be a non-empty map of node ids to nodes."],
    };
  // Every node starts an agent, so this much is known before any node is read.
  if (nodeKeys.length > MAX_AGENTS_PER_WORKFLOW)
    return {
      ok: false,
      problems: [
        ...problems,
        `graph has ${nodeKeys.length} nodes, but a workflow runs at most ${MAX_AGENTS_PER_WORKFLOW} agents.`,
      ],
    };
  const nodes: Record<string, GraphNode> = Object.create(null);
  for (const key of nodeKeys.sort()) {
    try {
      id(key, "node");
    } catch (error) {
      problems.push(key + ": " + messageOf(error));
      continue;
    }
    const parsedNode = parseNode(rawNodes[key]);
    if ("node" in parsedNode) nodes[key] = parsedNode.node;
    else problems.push(...parsedNode.problems.map((problem) => key + ": " + problem));
  }
  let name: string | undefined;
  if (source.name !== undefined) {
    try {
      name = text(source.name, "name");
    } catch (error) {
      problems.push(messageOf(error));
    }
  }
  // Judgment checks add judge agents, so the nodes' worst case is known once they are read.
  const agentsNeeded = Object.values(nodes).reduce(
    (sum, node) => sum + maxAgentsPerCall(node.verify?.type),
    0,
  );
  if (agentsNeeded > MAX_AGENTS_PER_WORKFLOW)
    return {
      ok: false,
      problems: [
        ...problems,
        `graph can start up to ${agentsNeeded} agents (each node, plus up to ${MAX_AGENT_ATTEMPTS} judges for each judgment check), but a workflow runs at most ${MAX_AGENTS_PER_WORKFLOW}.`,
      ],
    };
  const paths = new Map<string, string>();
  for (const [key, node] of Object.entries(nodes)) {
    for (const dep of node.dependsOn)
      if (!Object.hasOwn(rawNodes, dep)) problems.push(key + ": unknown dependsOn node " + dep);
    for (const input of node.inputs) {
      if (input.kind !== "task_output") continue;
      if (!node.dependsOn.includes(input.nodeId))
        problems.push(
          key + ": task_output " + input.id + " producer " + input.nodeId + " is not in dependsOn.",
        );
      // A producer that failed to parse has its own problems; its outputs are not known to be missing.
      const producer = nodes[input.nodeId];
      if (
        (producer !== undefined || !Object.hasOwn(rawNodes, input.nodeId)) &&
        !producer?.outputs.some((output) => output.id === input.outputId)
      )
        problems.push(
          key +
            ": task_output " +
            input.id +
            " references undeclared output " +
            input.nodeId +
            "." +
            input.outputId,
        );
    }
    for (const output of node.outputs) {
      const previous = paths.get(output.path);
      if (previous !== undefined)
        problems.push(key + ": output path " + output.path + " is also declared by " + previous);
      else paths.set(output.path, key);
    }
  }
  const visited = new Set<string>();
  const active: string[] = [];
  const visit = (key: string): void => {
    const cycleAt = active.indexOf(key);
    if (cycleAt !== -1) {
      problems.push("Dependency cycle: " + [...active.slice(cycleAt), key].join(" -> "));
      return;
    }
    if (visited.has(key) || nodes[key] === undefined) return;
    active.push(key);
    for (const dep of nodes[key].dependsOn) visit(dep);
    active.pop();
    visited.add(key);
  };
  for (const key of Object.keys(nodes)) visit(key);
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, graph: { schemaVersion: 1, ...(name === undefined ? {} : { name }), nodes } };
}

function writePaths(node: GraphNode): string[] {
  return [
    ...new Set([...(node.scopes?.write ?? []), ...node.outputs.map((output) => output.path)]),
  ].sort();
}

export function reviewGraph(
  value: unknown,
  inputHashes: Readonly<Record<string, InputHash>>,
  drivers?: AdvisoryDrivers,
) {
  const parsed = parseGraph(value);
  const inputs: Record<string, InputHash> = Object.create(null);
  const blockers = parsed.ok ? [] : [...parsed.problems];
  const layers = parsed.ok ? graphLayers(parsed.graph) : [];
  const writeConflicts: Array<{ nodes: string[]; paths: string[] }> = [];
  if (parsed.ok) {
    for (const [key, node] of Object.entries(parsed.graph.nodes)) {
      for (const input of node.inputs) {
        if (input.kind !== "workspace_snapshot") continue;
        const hash = Object.hasOwn(inputHashes, input.path)
          ? (inputHashes[input.path] ?? "missing")
          : "missing";
        inputs[input.path] = hash;
        if (hash === "missing" || hash === "too_large")
          blockers.push(key + ": input " + input.id + " (" + input.path + ") is " + hash + ".");
        else if (hash.sizeBytes > input.maxBytes)
          blockers.push(
            key +
              ": input " +
              input.id +
              " (" +
              input.path +
              ") is too_large for its " +
              input.maxBytes +
              "-byte bound.",
          );
      }
    }
    // Any two nodes without a path between them may run at once, whatever their layers.
    const ancestors = new Map<string, Set<string>>();
    const ancestorsOf = (key: string): Set<string> => {
      const known = ancestors.get(key);
      if (known !== undefined) return known;
      const found = new Set<string>();
      for (const dep of parsed.graph.nodes[key]?.dependsOn ?? []) {
        found.add(dep);
        for (const above of ancestorsOf(dep)) found.add(above);
      }
      ancestors.set(key, found);
      return found;
    };
    // Only nodes that write can conflict, and each one's write paths are worked out once.
    const writers = layers.flat().flatMap((key) => {
      const node = parsed.graph.nodes[key];
      const paths = node === undefined ? [] : writePaths(node);
      return paths.length === 0 ? [] : [{ key, paths }];
    });
    writers.forEach((left, index) => {
      for (let next = index + 1; next < writers.length; next += 1) {
        const right = writers[next]!;
        if (!scopesOverlap(left.paths, right.paths)) continue;
        if (ancestorsOf(left.key).has(right.key) || ancestorsOf(right.key).has(left.key)) continue;
        writeConflicts.push({
          nodes: [left.key, right.key],
          paths: [
            ...new Set([
              ...left.paths.filter((path) => scopesOverlap([path], right.paths)),
              ...right.paths.filter((path) => scopesOverlap(left.paths, [path])),
            ]),
          ].sort(),
        });
      }
    });
  }
  return {
    layers,
    writeConflicts,
    blockers,
    inputs,
    // Advice only: the digest below never reads it.
    advisory: parsed.ok ? graphAdvisory(parsed.graph, layers, drivers, inputs) : undefined,
    digest: parsed.ok
      ? "sha256:" +
        NodeCrypto.createHash("sha256")
          .update(stableStringify({ graph: parsed.graph, inputs }))
          .digest("hex")
      : null,
  };
}

// The same layer function plans review and execution so their dependency semantics cannot drift.
export const GRAPH_DRIVER_SCRIPT = String.raw`
const graph = args.graph;
const hashes = args.inputs;
const layers = (${graphLayers.toString()})(graph);
const budgets = ${JSON.stringify(ATTEMPT_BUDGETS)};
const results = Object.create(null);
// Graphs started before plans existed resume without node(); they still run, untagged.
const recordsNodes = typeof node === "function";
const failedNode = (reason, inputs = {}) => ({
  status: "failed", attempts: 0, inputs, outputs: {}, verification: null, reason,
});
const layerOf = Object.create(null);
layers.forEach((layer, index) => {
  layer.forEach((key) => { layerOf[key] = index; });
  // Declared up front so the phases list in run order; nodes with their own phase add theirs.
  if (layer.some((key) => graph.nodes[key].phase === undefined)) phase("Layer " + (index + 1));
});
const total = Object.keys(graph.nodes).length;
let settled = 0;
// A node starts as soon as its own predecessors finish, not when their whole layer does.
const runNode = async (key) => {
    const node = graph.nodes[key];
    const layerLabel = "Layer " + (layerOf[key] + 1);
    const failed = node.dependsOn.find((dep) => results[dep].status !== "passed");
    if (failed !== undefined) {
      return {
        status: "skipped", attempts: 0, inputs: {}, outputs: {}, verification: null,
        reason: "Predecessor " + failed + " did not pass.",
      };
    }
    const inputs = [];
    const inputDigests = Object.create(null);
    for (const input of node.inputs) {
      let pinned;
      if (input.kind === "workspace_snapshot") {
        const hash = hashes[input.path];
        if (!hash || typeof hash !== "object" || typeof hash.sha256 !== "string") {
          return failedNode("Input " + input.id + " has no reviewed hash.", inputDigests);
        }
        pinned = { id: input.id, path: input.path, maxBytes: input.maxBytes, sha256: hash.sha256 };
      } else {
        const output = results[input.nodeId].outputs[input.outputId];
        if (!output) {
          return failedNode("Predecessor " + input.nodeId + " did not return output " + input.outputId + ".", inputDigests);
        }
        const declared = graph.nodes[input.nodeId].outputs.find((ref) => ref.id === input.outputId);
        pinned = {
          id: input.id, path: output.path, maxBytes: declared.maxBytes, sha256: output.sha256,
          from: input.nodeId,
        };
      }
      inputs.push(pinned);
      inputDigests[input.id] = pinned.sha256;
    }
    const options = {
      label: node.subject, phase: node.phase ?? layerLabel, inputs, outputs: node.outputs,
      attemptTimeoutMs: budgets[node.attemptBudget], report: true,
    };
    if (recordsNodes) options.node = key;
    for (const field of ["target", "role", "schema", "scopes", "verify", "stallTimeoutMs"]) {
      if (node[field] !== undefined) options[field] = node[field];
    }
    let report;
    try {
      report = await agent(node.description, options);
    } catch (error) {
      return failedNode(String(error), inputDigests);
    }
    if (!report) return failedNode("Agent did not pass.", inputDigests);
    return {
      status: report.ok === true ? "passed" : "failed", attempts: report.attempts,
      inputs: inputDigests, outputs: report.outputs, verification: report.verification,
      ...(report.reason ? { reason: report.reason } : report.ok === true ? {} : { reason: "Agent did not pass." }),
    };
};
const runs = Object.create(null);
const run = (key) =>
  runs[key] ??
  (runs[key] = Promise.all(graph.nodes[key].dependsOn.map(run)).then(async () => {
    try {
      results[key] = await runNode(key);
    } catch (error) {
      results[key] = failedNode(String(error));
    }
    // Once per node, including those that never reached agent(), so the app can show every node.
    if (recordsNodes) {
      const { status, attempts, reason, inputs, outputs } = results[key];
      const recorded = { status, attempts };
      if (reason) recorded.reason = reason;
      // Hashes and paths only, never content: the stored provenance a large result may leave out.
      if (Object.keys(inputs).length > 0) recorded.inputs = inputs;
      const files = Object.entries(outputs ?? {});
      if (files.length > 0) {
        recorded.outputs = Object.fromEntries(files.map(([id, file]) => [
          id, { path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes },
        ]));
      }
      node(key, recorded);
    }
    settled += 1;
    log(settled + "/" + total + " nodes finished; " + key + " " + results[key].status + ".");
  }));
await Promise.all(Object.keys(graph.nodes).sort().map(run));
const record = { ok: Object.values(results).every((node) => node.status === "passed"), nodes: results };
// A graph completes only when every node passed. A failed one throws the summary; each node's
// inputs and outputs are in the outcomes recorded above, for failed graphs too.
if (!record.ok) throw new Error((${workflowGraphFailureSummary.toString()})(
  Object.entries(results).map(([key, outcome]) => ({ ...outcome, label: graph.nodes[key].subject }))
));
return record;
`;

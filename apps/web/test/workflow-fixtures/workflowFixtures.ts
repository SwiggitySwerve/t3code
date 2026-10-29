/**
 * Deterministic workflow data for the fixture browser tests. Each fixture is a projected subagent
 * row, and everything the surfaces show is derived from it by the functions the app uses
 * (`resolveAppWorkflowView`, `workflowProgressText`, `appWorkflowHeading`), so a fixture can only
 * show what the real data can. Times are fixed offsets from `WORKFLOW_QA_NOW`.
 */
import {
  appWorkflowHeading,
  resolveAppWorkflowView,
  workflowProgressText,
  type SubagentWorkflowGroup,
  type WorkflowOpening,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  NodeId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2WorkflowAgent,
  type OrchestrationV2WorkflowNodeOutcome,
  type OrchestrationV2WorkflowPlan,
} from "@t3tools/contracts";
import { storedWorkflowScript } from "@t3tools/shared/storedWorkflowScript";
import {
  WORKFLOW_QA_SIDEBAR_STATES,
  WORKFLOW_QA_STATUSES,
  WORKFLOW_QA_STRESS,
} from "@t3tools/shared/testing/workflowQa";
import * as DateTime from "effect/DateTime";

import { QA_DRIVER as DRIVER, QA_PROVIDER_INSTANCE as PROVIDER, QA_PROVIDERS } from "./providers";

/** The frozen clock: elapsed times in a frame never depend on when the test ran. */
export const WORKFLOW_QA_NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

export {
  WORKFLOW_QA_SIDEBAR_STATES,
  WORKFLOW_QA_STATUSES,
  WORKFLOW_QA_STRESS,
} from "@t3tools/shared/testing/workflowQa";
export type WorkflowQaStatus = (typeof WORKFLOW_QA_STATUSES)[number];
export type WorkflowQaStress = (typeof WORKFLOW_QA_STRESS)[number];

export type WorkflowQaVariant = WorkflowQaStatus | WorkflowQaStress;

export type WorkflowQaSidebarState = (typeof WORKFLOW_QA_SIDEBAR_STATES)[number];
export type WorkflowQaKind = "graph" | "script";

const WORKER_MODEL = "claude-haiku-5-5";

type AgentState = OrchestrationV2WorkflowAgent["state"];

interface AgentSpec {
  readonly state: AgentState;
  /** `null` leaves the model and provider off the member, as a record that never learned them. */
  readonly identity?: { readonly provider: string; readonly model?: string } | null;
  readonly tokens?: number;
  readonly durationMs?: number;
  readonly result?: string;
  readonly prompt?: string;
  /** Earlier failed attempts before this one. */
  readonly retries?: number;
}

interface NodeSpec {
  readonly key: string;
  readonly label: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly agent?: AgentSpec;
  readonly outcome?: OrchestrationV2WorkflowNodeOutcome;
}

type RunStatus = "running" | "completed" | "failed" | "cancelled";

interface RunSpec {
  readonly title: string;
  readonly status: RunStatus;
  readonly nodes: ReadonlyArray<NodeSpec>;
  /** The latest log line while the run is live; a finished run reports through its result. */
  readonly progress: string | null;
}

const worker = { provider: "cliproxy", model: WORKER_MODEL } as const;

/** Dependency depth: 0 without dependencies, otherwise one past the deepest dependency. */
function waveOf(node: NodeSpec, byKey: ReadonlyMap<string, NodeSpec>): number {
  return node.dependsOn.length === 0
    ? 0
    : 1 + Math.max(...node.dependsOn.map((key) => waveOf(byKey.get(key)!, byKey)));
}

function graphWorkflow(run: RunSpec) {
  const byKey = new Map(run.nodes.map((node) => [node.key, node] as const));
  const plan: OrchestrationV2WorkflowPlan = {
    nodes: run.nodes.map((node) => ({
      key: node.key,
      label: node.label,
      wave: waveOf(node, byKey),
      dependsOn: [...node.dependsOn],
    })),
  };
  const nodeOutcomes = Object.fromEntries(
    run.nodes.flatMap((node) => (node.outcome === undefined ? [] : [[node.key, node.outcome]])),
  );
  const agents = run.nodes.flatMap((node) =>
    node.agent === undefined ? [] : [{ node, agent: node.agent }],
  );
  return {
    plan,
    nodeOutcomes,
    agents: agents.map(({ node, agent }, index) =>
      workflowAgent({ index, label: node.label, graphNodeKey: node.key }, agent),
    ),
  };
}

function workflowAgent(
  base: {
    index: number;
    label: string;
    graphNodeKey?: string;
    phaseIndex?: number;
    phaseTitle?: string;
  },
  spec: AgentSpec,
): OrchestrationV2WorkflowAgent {
  const identity = spec.identity === undefined ? worker : spec.identity;
  const duration = spec.durationMs ?? 0;
  const started = spec.state === "queued" ? undefined : WORKFLOW_QA_NOW - duration;
  const finished = spec.state === "completed" || spec.state === "failed";
  const taskId = `qa-task-${base.index}`;
  return {
    ...base,
    state: spec.state,
    agentId: taskId,
    ...(spec.state === "queued" ? {} : { childThreadId: ThreadId.make(`qa-thread-${base.index}`) }),
    ...(identity === null
      ? {}
      : {
          providerInstanceId: ProviderInstanceId.make(identity.provider),
          driver:
            QA_PROVIDERS.find((provider) => provider.instanceId === identity.provider)?.driver ??
            DRIVER,
          ...(identity.model === undefined ? {} : { model: identity.model }),
        }),
    ...(spec.tokens === undefined ? {} : { totalTokens: spec.tokens }),
    ...(started === undefined ? {} : { startedAt: started }),
    ...(started !== undefined && finished
      ? { completedAt: started + duration, durationMs: duration }
      : {}),
    ...(spec.result === undefined ? {} : { result: spec.result }),
    ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }),
    ...(spec.state === "queued" ? {} : attemptRecords(base.index, spec, identity)),
  };
}

/** One record per child task, as the server writes them: earlier attempts failed, the last is the member's. */
function attemptRecords(index: number, spec: AgentSpec, identity: AgentSpec["identity"]) {
  const retries = spec.retries ?? 0;
  const attempts = retries + 1;
  const taskId = (attempt: number) => NodeId.make(`qa-task-${index}-attempt-${attempt}`);
  const duration = (spec.durationMs ?? 0) / attempts;
  return {
    ...(retries === 0 ? {} : { attempt: retries }),
    attemptTaskIds: Array.from({ length: attempts }, (_, attempt) => taskId(attempt)),
    attemptHistory: Array.from({ length: attempts }, (_, attempt) => {
      const last = attempt === retries;
      const running = last && spec.state === "running";
      return {
        taskId: taskId(attempt),
        childThreadId: ThreadId.make(`qa-thread-${index}${retries === 0 ? "" : `-${attempt}`}`),
        attempt,
        state: last
          ? spec.state === "failed"
            ? ("failed" as const)
            : running
              ? ("running" as const)
              : ("completed" as const)
          : ("failed" as const),
        providerInstanceId:
          identity == null ? PROVIDER : ProviderInstanceId.make(identity.provider),
        ...(identity?.model === undefined ? {} : { model: identity.model }),
        totalTokens: Math.round((spec.tokens ?? 0) / attempts),
        usageStatus: "complete" as const,
        timingComplete: !running,
        startedAt: WORKFLOW_QA_NOW - (spec.durationMs ?? 0) + attempt * duration,
        ...(running
          ? { activeStartedAt: WORKFLOW_QA_NOW - duration, completedDurationMs: 0 }
          : { durationMs: duration }),
      };
    }),
  };
}
const SOURCES = "Count source files";
const DOCS = "Count documentation files";

function baseNodes(): ReadonlyArray<Pick<NodeSpec, "key" | "label" | "dependsOn">> {
  return [
    { key: "scan-src", label: SOURCES, dependsOn: [] },
    { key: "scan-docs", label: DOCS, dependsOn: [] },
    { key: "combine", label: "Combine the counts", dependsOn: ["scan-src", "scan-docs"] },
    { key: "report", label: "Write the report", dependsOn: ["combine"] },
  ];
}

const passed = (attempts = 1): OrchestrationV2WorkflowNodeOutcome => ({
  status: "passed",
  attempts,
});
const ok = (tokens: number, durationMs: number, result: string): AgentSpec => ({
  state: "completed",
  tokens,
  durationMs,
  result,
});

/** The four-node graph in each run state. */
function graphRun(status: WorkflowQaStatus): RunSpec {
  const [src, docs, combine, report] = baseNodes() as [NodeSpec, NodeSpec, NodeSpec, NodeSpec];
  switch (status) {
    case "queued":
      return {
        title: "Project file counts",
        status: "running",
        progress: null,
        nodes: [
          { ...src, agent: { state: "queued" } },
          { ...docs, agent: { state: "queued" } },
          combine,
          report,
        ],
      };
    case "running":
      return {
        title: "Project file counts",
        status: "running",
        progress: "Started Count documentation files",
        nodes: [
          { ...src, agent: ok(18_400, 41_000, "412 source files."), outcome: passed() },
          { ...docs, agent: { state: "running", tokens: 6_200, durationMs: 23_000 } },
          combine,
          report,
        ],
      };
    case "retrying":
      return {
        title: "Project file counts",
        status: "running",
        progress: "Retrying Count documentation files",
        nodes: [
          { ...src, agent: ok(18_400, 41_000, "412 source files."), outcome: passed() },
          { ...docs, agent: { state: "running", tokens: 31_000, durationMs: 96_000, retries: 2 } },
          combine,
          report,
        ],
      };
    case "passed":
      return {
        title: "Project file counts",
        status: "completed",
        progress: null,
        nodes: [
          { ...src, agent: ok(18_400, 41_000, "412 source files."), outcome: passed() },
          { ...docs, agent: ok(12_900, 33_000, "57 documentation files."), outcome: passed() },
          { ...combine, agent: ok(9_100, 12_000, "469 files in total."), outcome: passed() },
          { ...report, agent: ok(7_700, 9_000, "Report written to counts.md."), outcome: passed() },
        ],
      };
    case "failed":
      return {
        title: "Project file counts",
        status: "failed",
        progress: null,
        nodes: [
          { ...src, agent: ok(18_400, 41_000, "412 source files."), outcome: passed() },
          {
            ...docs,
            agent: {
              state: "failed",
              tokens: 8_300,
              durationMs: 19_000,
              result: "The command exited with code 1: docs/ was not found.",
            },
            outcome: {
              status: "failed",
              reason: "The command exited with code 1: docs/ was not found.",
              attempts: 1,
            },
          },
          { ...combine, outcome: { status: "skipped", reason: `Skipped because ${DOCS} failed.` } },
          { ...report, outcome: { status: "skipped", reason: `Skipped because ${DOCS} failed.` } },
        ],
      };
    case "stopped":
      return {
        title: "Project file counts",
        status: "cancelled",
        progress: null,
        nodes: [
          { ...src, agent: ok(18_400, 41_000, "412 source files."), outcome: passed() },
          { ...docs, agent: { state: "running", tokens: 6_200, durationMs: 23_000 } },
          combine,
          report,
        ],
      };
  }
}

const LONG_LABEL =
  "Audit every package manifest, lockfile and workspace override for drift between declared and resolved dependency versions 日本語 🧪";
const LONG_PROVIDER = "claude-proxy-with-a-very-long-provider-instance-name";
const LONG_MODEL = "claude-sonnet-5-5-20261001-extended-thinking-preview";
// Longer than the 240 characters a failure summary keeps, shorter than the 500 a node reason keeps.
const LONG_REASON =
  "The command exited with code 1 after printing a very long diagnostic that mentions /var/lib/build/cache/workspace/packages/example/src/generated/index.ts, then /var/lib/build/cache/workspace/packages/example/src/generated/routes.ts, then a stack of forty frames from the bundler, and does not stop there.";

function fourStageRun(): RunSpec {
  return {
    title: "Repository health audit",
    status: "running",
    progress: "Cross-checking completed audits; retrying the desktop audit",
    nodes: [
      {
        key: "survey",
        label: "Survey the workspace",
        dependsOn: [],
        agent: ok(8_400, 18_000, "Mapped seven packages and their public boundaries."),
        outcome: passed(),
      },
      {
        key: "contracts",
        label: "Audit API contracts",
        dependsOn: ["survey"],
        agent: ok(24_600, 48_000, "Checked request schemas and compatibility."),
        outcome: passed(),
      },
      {
        key: "shared",
        label: "Audit shared utilities",
        dependsOn: ["survey"],
        agent: ok(18_200, 42_000, "Checked parsing and error handling."),
        outcome: passed(),
      },
      {
        key: "client-runtime",
        label: "Audit client runtime",
        dependsOn: ["survey"],
        agent: ok(31_800, 65_000, "Checked state transitions and subscriptions."),
        outcome: passed(),
      },
      {
        key: "server",
        label: "Audit server orchestration",
        dependsOn: ["survey"],
        agent: { state: "running", tokens: 37_500, durationMs: 85_000 },
      },
      {
        key: "web",
        label: "Audit web components",
        dependsOn: ["survey"],
        agent: { state: "running", tokens: 28_300, durationMs: 76_000 },
      },
      {
        key: "mobile",
        label: "Audit mobile client",
        dependsOn: ["survey"],
        agent: { state: "running", tokens: 22_700, durationMs: 70_000 },
      },
      {
        key: "desktop",
        label: "Audit desktop bridge",
        dependsOn: ["survey"],
        agent: { state: "running", tokens: 34_200, durationMs: 90_000, retries: 1 },
      },
      {
        key: "schema-parity",
        label: "Cross-check schema compatibility",
        dependsOn: ["contracts", "shared"],
        agent: { state: "running", tokens: 6_900, durationMs: 16_000 },
      },
      {
        key: "state-parity",
        label: "Cross-check client state handling",
        dependsOn: ["contracts", "client-runtime"],
        agent: { state: "running", tokens: 4_800, durationMs: 10_000 },
      },
      {
        key: "error-parity",
        label: "Cross-check error propagation",
        dependsOn: ["shared", "client-runtime"],
        agent: { state: "queued" },
      },
      {
        key: "auth-boundaries",
        label: "Cross-check authorization boundaries",
        dependsOn: ["contracts", "server"],
      },
      {
        key: "client-parity",
        label: "Cross-check web and mobile behavior",
        dependsOn: ["web", "mobile"],
      },
      {
        key: "ipc-boundaries",
        label: "Cross-check desktop IPC boundaries",
        dependsOn: ["desktop", "server"],
      },
      {
        key: "report",
        label: "Write the audit report",
        dependsOn: [
          "schema-parity",
          "state-parity",
          "error-parity",
          "auth-boundaries",
          "client-parity",
          "ipc-boundaries",
        ],
      },
    ],
  };
}

function stressRun(stress: WorkflowQaStress): RunSpec {
  switch (stress) {
    case "four-stage-running":
      return fourStageRun();
    case "long-labels":
      return {
        title:
          "Dependency drift audit across every package in the monorepo and its generated workspaces",
        status: "failed",
        progress: null,
        nodes: [
          {
            key: "audit",
            label: LONG_LABEL,
            dependsOn: [],
            agent: {
              state: "failed",
              identity: { provider: LONG_PROVIDER, model: LONG_MODEL },
              tokens: 1_234_567,
              durationMs: 3_725_000,
              result: LONG_REASON,
              retries: 1,
            },
            outcome: { status: "failed", reason: LONG_REASON, attempts: 2 },
          },
          {
            key: "summary",
            label: `Summarize: ${LONG_LABEL}`,
            dependsOn: ["audit"],
            outcome: { status: "skipped", reason: LONG_REASON },
          },
        ],
      };
    case "missing-model":
      return {
        title: "Project file counts",
        status: "running",
        progress: null,
        nodes: [
          {
            key: "scan-src",
            label: SOURCES,
            dependsOn: [],
            agent: { state: "running", identity: null, durationMs: 14_000 },
          },
          { key: "scan-docs", label: DOCS, dependsOn: [] },
          {
            key: "report",
            label: "Write the report",
            dependsOn: ["scan-src", "scan-docs"],
          },
        ],
      };
    case "many-nodes": {
      // 15 waves of 10: the size at which the canvas windows its cards.
      const nodes: Array<NodeSpec> = [];
      for (let wave = 0; wave < 15; wave += 1) {
        for (let row = 0; row < 10; row += 1) {
          const key = `n${wave}-${row}`;
          const settled = wave < 5;
          nodes.push({
            key,
            label: `Audit package ${wave}-${row}`,
            dependsOn: wave === 0 ? [] : [`n${wave - 1}-${row}`],
            ...(settled
              ? { agent: ok(4_000 + row, 9_000, "Clean."), outcome: passed() }
              : wave === 5
                ? { agent: { state: "running" as const, tokens: 900, durationMs: 4_000 } }
                : {}),
          });
        }
      }
      return {
        title: "Audit of 150 packages",
        status: "running",
        progress: "Auditing wave 6 of 15",
        nodes,
      };
    }
  }
}

function runSpec(variant: WorkflowQaVariant): RunSpec {
  return (WORKFLOW_QA_STATUSES as ReadonlyArray<string>).includes(variant)
    ? graphRun(variant as WorkflowQaStatus)
    : stressRun(variant as WorkflowQaStress);
}

// A script has no dependencies: its agents sit in phases, and a running agent's row shows its prompt.
const COMMAND_PROMPT =
  "Run this command exactly once: ping -n 181 127.0.0.1 . Wait for it to finish, then reply done.";

function scriptAgents(variant: WorkflowQaVariant): ReadonlyArray<OrchestrationV2WorkflowAgent> {
  const long = variant === "long-labels";
  const identity: AgentSpec["identity"] =
    variant === "missing-model"
      ? null
      : long
        ? { provider: LONG_PROVIDER, model: LONG_MODEL }
        : worker;
  const label = (text: string) => (long ? `${text}: ${LONG_LABEL}` : text);
  const phase = (index: number, title: string) => ({
    phaseIndex: index,
    phaseTitle: long ? `${title} ${LONG_LABEL}` : title,
  });
  const spec = (state: AgentState, extra: Partial<AgentSpec> = {}): AgentSpec => ({
    state,
    identity,
    ...(state === "queued" ? {} : { tokens: 5_400, durationMs: 31_000 }),
    ...extra,
  });
  const done = spec("completed", { result: long ? LONG_REASON : "412 source files." });
  const running = spec("running", { prompt: COMMAND_PROMPT });
  const queued = spec("queued", { prompt: COMMAND_PROMPT });
  const failed = spec("failed", { result: long ? LONG_REASON : "The command exited with code 1." });
  const rows: ReadonlyArray<[string, number, string, AgentSpec]> = (() => {
    switch (variant) {
      case "queued":
        return [
          ["Read files", 0, "Research", queued],
          ["Read docs", 0, "Research", queued],
          ["Draft summary", 1, "Write", queued],
        ];
      case "passed":
        return [
          ["Read files", 0, "Research", done],
          ["Read docs", 0, "Research", done],
          ["Draft summary", 1, "Write", done],
        ];
      case "failed":
        return [
          ["Read files", 0, "Research", done],
          ["Read docs", 0, "Research", failed],
          ["Draft summary", 1, "Write", queued],
        ];
      case "long-labels":
        return [
          ["Read files", 0, "Research", failed],
          ["Read docs", 0, "Research", running],
          ["Draft summary", 1, "Write", queued],
        ];
      case "many-nodes":
        // The same size as the graph stress: 15 phases of 10.
        return Array.from({ length: 150 }, (_, index) => [
          `Read file ${index}`,
          Math.floor(index / 10),
          `Batch ${Math.floor(index / 10) + 1}`,
          index < 50 ? done : index < 60 ? running : queued,
        ]);
      case "four-stage-running": {
        const run = fourStageRun();
        const byKey = new Map(run.nodes.map((node) => [node.key, node] as const));
        const titles = ["Workspace survey", "Package audits", "Cross-checks", "Final report"];
        return run.nodes.map((node) => {
          const index = waveOf(node, byKey);
          return [
            node.label,
            index,
            titles[index]!,
            { prompt: node.label, ...(node.agent ?? { state: "queued" }) },
          ];
        });
      }
      default:
        // running, stopped and retrying share members; the stopped run's coordinator ends them.
        return [
          ["Read files", 0, "Research", done],
          ["Read docs", 0, "Research", running],
          ["Draft summary", 1, "Write", queued],
        ];
    }
  })();
  return rows.map(([text, index, title, agent], position) =>
    workflowAgent({ index: position, label: label(text), ...phase(index, title) }, agent),
  );
}

function scriptRunStatus(variant: WorkflowQaVariant): RunStatus {
  switch (variant) {
    case "passed":
      return "completed";
    case "failed":
    case "long-labels":
      return "failed";
    case "stopped":
      return "cancelled";
    default:
      return "running";
  }
}

export interface WorkflowQaFixture {
  /** The row the server projects for the workflow; every field below is derived from it. */
  readonly row: WorkflowQaRow;
  readonly opening: WorkflowOpening;
  readonly group: SubagentWorkflowGroup;
  /** What `AppWorkflowTimelineBlock` passes as the block's heading. */
  readonly heading: string;
  /** What `AppWorkflowTimelineBlock` passes as the block's progress line. */
  readonly progress: string | null;
  readonly running: boolean;
}

type WorkflowQaRow = Parameters<typeof resolveAppWorkflowView>[0];

/** Written into every stored script so a frame (or a test) shows it if a surface ever renders it. */
export const WORKFLOW_QA_SCRIPT_MARKER = "QA-SCRIPT-SOURCE-MUST-NOT-RENDER";

/** The id the app-owned workflow row has in every fixture. */
const WORKFLOW_ID = "qa-workflow";

/** What the server stores as the row's `result` when the run ends, as the runner and orchestrator write it. */
function terminalResult(
  kind: WorkflowQaKind,
  run: RunSpec,
  status: RunStatus,
  variant: WorkflowQaVariant,
): string | null {
  if (status === "running") return null;
  if (status === "cancelled") return "Workflow stopped.";
  const long = variant === "long-labels";
  if (kind === "script") {
    return status === "completed"
      ? JSON.stringify("Counted 412 source files and 57 documentation files.", null, 2)
      : `The workflow failed: ${long ? `Read files: ${LONG_REASON}` : "Read docs: the command exited with code 1."}`;
  }
  const nodes = Object.fromEntries(
    run.nodes.map((node) => [node.key, node.outcome ?? { status: "skipped" }]),
  );
  return status === "completed"
    ? JSON.stringify({ ok: true, nodes }, null, 2)
    : `The workflow failed: Graph failed: ${JSON.stringify({ ok: false, nodes })}`;
}

export function workflowFixture(
  kind: WorkflowQaKind,
  variant: WorkflowQaVariant,
): WorkflowQaFixture {
  const run = runSpec(variant);
  const status = kind === "graph" ? run.status : scriptRunStatus(variant);
  const terminal = status !== "running";
  const workflow =
    kind === "graph"
      ? graphWorkflow(run)
      : { agents: scriptAgents(variant), plan: undefined, nodeOutcomes: undefined };
  const phases =
    kind === "graph"
      ? []
      : [
          ...new Map(
            workflow.agents.map((agent) => [agent.phaseIndex!, agent.phaseTitle!] as const),
          ),
        ].map(([index, title]) => ({ index, title }));
  const name =
    variant === "long-labels" || variant === "four-stage-running" || kind === "graph"
      ? run.title
      : "State audit";
  const row: WorkflowQaRow = {
    id: WORKFLOW_ID,
    title: name,
    // A graph's generated runner and a script's source stay out of the timeline.
    prompt: storedWorkflowScript(
      `export const meta = { name: "qa" }; // ${WORKFLOW_QA_SCRIPT_MARKER}`,
      {},
    ),
    model: null,
    origin: "app_owned",
    parentNodeId: NodeId.make("qa-caller"),
    driver: DRIVER,
    providerInstanceId: PROVIDER,
    childThreadId: null,
    status,
    ...(status === "running" && run.progress !== null && kind === "graph"
      ? { progress: run.progress }
      : {}),
    result: terminalResult(kind, run, status, variant),
    startedAt: DateTime.makeUnsafe(WORKFLOW_QA_NOW - 120_000),
    completedAt: terminal ? DateTime.makeUnsafe(WORKFLOW_QA_NOW - 1_000) : null,
    updatedAt: DateTime.makeUnsafe(WORKFLOW_QA_NOW),
    workflow: {
      name,
      phases,
      agents: workflow.agents,
      ...(workflow.plan === undefined ? {} : { plan: workflow.plan }),
      ...(workflow.nodeOutcomes === undefined ? {} : { nodeOutcomes: workflow.nodeOutcomes }),
    },
  };
  const opening = resolveAppWorkflowView(row);
  if (opening?.group == null) throw new Error("The fixture row is not a T3-run workflow.");
  return {
    row,
    opening,
    group: opening.group,
    heading: appWorkflowHeading(row.status),
    progress: workflowProgressText(row),
    running: status === "running",
  };
}

export function workflowScaleFixture(kind: WorkflowQaKind, count: 4 | 40 | 256): WorkflowQaFixture {
  const seed = workflowFixture(kind, "running");
  const phaseSize = count === 256 ? 16 : count === 40 ? 10 : 2;
  const agents = Array.from({ length: count }, (_, index) =>
    workflowAgent(
      {
        index,
        label: `Agent ${index + 1}`,
        phaseIndex: Math.floor(index / phaseSize),
        phaseTitle: `Phase ${Math.floor(index / phaseSize) + 1}`,
        ...(kind === "graph" ? { graphNodeKey: `task-${index}` } : {}),
      },
      {
        state:
          index === count - 1
            ? "failed"
            : index < count / 2
              ? "completed"
              : index < count * 0.75
                ? "running"
                : "queued",
        ...(index === count - 1 ? { result: "Access denied. Check workspace permissions." } : {}),
        prompt: "These are task instructions, not live activity.",
        ...(index === 0 ? { retries: 2 } : {}),
      },
    ),
  );
  const row: WorkflowQaRow = {
    ...seed.row,
    progress: "Reviewing package exports",
    workflow: {
      name: `Audit ${count} agents`,
      agents,
      phases: Array.from({ length: count / phaseSize }, (_, index) => ({
        index,
        title: `Phase ${index + 1}`,
      })),
      ...(kind === "graph"
        ? {
            plan: {
              nodes: agents.map((agent) => ({
                key: agent.graphNodeKey!,
                label: agent.label,
                wave: agent.phaseIndex!,
                dependsOn:
                  agent.phaseIndex === 0 ? [] : [`task-${(agent.phaseIndex! - 1) * phaseSize}`],
              })),
            },
            nodeOutcomes: Object.fromEntries(
              agents.flatMap((agent): Array<[string, OrchestrationV2WorkflowNodeOutcome]> =>
                agent.state === "completed"
                  ? [[agent.graphNodeKey!, { status: "passed" }]]
                  : agent.state === "failed"
                    ? [[agent.graphNodeKey!, { status: "failed", reason: agent.result! }]]
                    : [],
              ),
            ),
          }
        : {}),
    },
  };
  const opening = resolveAppWorkflowView(row)!;
  return {
    row,
    opening,
    group: opening.group!,
    heading: appWorkflowHeading(row.status),
    progress: workflowProgressText(row),
    running: true,
  };
}

export function workflowModelGlyphFixture(): WorkflowQaFixture {
  const seed = workflowFixture("graph", "running");
  const models = [
    ["Sol analyst", "openai.gpt-6.1-sol", "cliproxy"],
    ["Astra architect", "gpt-6-astra", "cliproxy"],
    ["Terra reviewer", "openai/gpt-6.1-terra", "cursor-work"],
    ["Luna implementer", "gpt-6-luna", "cursor-work"],
    ["Opus planner", "claude-opus-5-5", "cliproxy"],
    ["Sonnet researcher", "anthropic/claude-sonnet-4-6", "cliproxy"],
    ["Fable writer", "claude-fable-5-1", "cursor-work"],
    ["Haiku verifier", "claude-haiku-5-5", "cursor-work"],
    ["Unknown model", "vendor/claude-opus-5-5-custom", "cursor-work"],
    ["Unknown harness", "custom-model", "lab-runner"],
    ["Missing model", null, "cliproxy"],
    ["Unavailable instance", "custom-model", "retired-instance"],
  ] as const;
  const agents = models.map(([label, model, provider], index) =>
    workflowAgent(
      { index, label, graphNodeKey: `model-${index}` },
      {
        state: index < 8 ? "completed" : "running",
        identity: { ...(model === null ? {} : { model }), provider },
        tokens: 1200,
        durationMs: index < 8 ? 1200 : 600,
      },
    ),
  );
  const row: WorkflowQaRow = {
    ...seed.row,
    progress: "",
    workflow: {
      name: "Model identities across providers",
      agents,
      phases: [],
      nodeOutcomes: Object.fromEntries(
        agents.slice(0, 8).map((agent) => [agent.graphNodeKey!, { status: "passed" as const }]),
      ),
      plan: {
        nodes: agents.map((agent, index) => ({
          key: agent.graphNodeKey!,
          label: agent.label,
          wave: Math.floor(index / 4),
          dependsOn: index < 4 ? [] : [`model-${index - 4}`],
        })),
      },
    },
  };
  const opening = resolveAppWorkflowView(row)!;
  return { ...seed, row, opening, group: opening.group!, progress: workflowProgressText(row) };
}

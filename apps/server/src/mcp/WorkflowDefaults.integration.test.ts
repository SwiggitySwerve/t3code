import { describe, expect, it } from "@effect/vitest";
import type { ProviderOptionDescriptor, ServerProvider } from "@t3tools/contracts";
import { parseStoredWorkflowScript } from "@t3tools/shared/storedWorkflowScript";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { parseRateTable } from "../usage/usagePricing.ts";
import {
  answerWorkflowAgents,
  awaitMember,
  awaitWorkflowEnd,
  childTasks,
  claudeInstanceId,
  claudeModel,
  claudeProvider,
  completeChild,
  decodeReview,
  decodeWorkflow,
  instanceId,
  invocation,
  invoke,
  layerTest,
  makeLayerTest,
  model,
  parentThreadId,
  provider,
  reviewGraph,
  startParent,
  withServerProcess,
} from "./WorkflowHarness.testkit.ts";
import { NO_DEFAULT_JUDGE_NOTE } from "./workflowDefaults.ts";

const MINI = "gpt-5.4-mini";
const HAIKU = "claude-haiku-4-5";

const reasoning = (id: string, values: ReadonlyArray<string>): ProviderOptionDescriptor => ({
  id,
  label: "Reasoning",
  type: "select",
  options: values.map((value) => ({ id: value, label: value })),
});
const withEfforts = (
  base: ServerProvider,
  slugs: ReadonlyArray<string>,
  descriptor: ProviderOptionDescriptor,
): ServerProvider => ({
  ...base,
  models: slugs.map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: { optionDescriptors: [descriptor] },
  })),
});
const codex = withEfforts(
  provider,
  [model, MINI],
  reasoning("reasoningEffort", ["minimal", "low", "medium", "high", "xhigh"]),
);
const claude = withEfforts(
  claudeProvider,
  [claudeModel, HAIKU],
  reasoning("effort", ["default", "low", "medium", "high", "max"]),
);
const price = (input: number, output: number) => ({
  input_cost_per_token: input / 1e6,
  output_cost_per_token: output / 1e6,
});
// Base list prices only; the cheapest is gpt-5.4-mini, and claude-haiku-4-5 the cheapest Claude.
const rates = parseRateTable({
  [model]: price(1.25, 10),
  [MINI]: price(0.25, 2),
  [claudeModel]: price(3, 15),
  [HAIKU]: price(1, 5),
});
const layerPriced = makeLayerTest(undefined, [codex, claude], undefined, undefined, rates);
const layerOneFamily = makeLayerTest(undefined, [codex], undefined, undefined, rates);

const on = (providerInstanceId: string, slug: string, id?: string, effort?: string) => ({
  providerInstanceId,
  model: slug,
  options: id === undefined ? [] : [{ id, value: effort }],
  inheritOptions: false,
});
const codexAt = (slug: string, effort: string) => on(instanceId, slug, "reasoningEffort", effort);
const ladder = {
  target: codexAt(MINI, "low"),
  retries: [codexAt(MINI, "high"), codexAt(model, "high")],
};
const haikuJudge = on(claudeInstanceId, HAIKU, "effort", "medium");

const judgment = { type: "judgment", rubric: ["It is done."] };
const node = (overrides: Record<string, unknown> = {}) => ({
  subject: "work",
  description: "Do the work.",
  dependsOn: [],
  ...overrides,
});
const graph = {
  schemaVersion: 1,
  nodes: {
    a: node({ subject: "first", verify: judgment }),
    b: node({
      subject: "second",
      target: { providerInstanceId: claudeInstanceId, model: claudeModel },
      verify: judgment,
    }),
    c: node({ subject: "third" }),
  },
};

const passingChecker = (prompt: string) =>
  prompt.includes("independent checker")
    ? `\`\`\`json\n${JSON.stringify({ outcome: "passed", reasons: "Fine." })}\n\`\`\``
    : "done";

describe("T3's cheap-first defaults", () => {
  it.effect("graph_review writes them into the graph its digest covers and its card shows", () =>
    Effect.gen(function* () {
      yield* startParent;
      const reviewed = yield* reviewGraph(graph);
      expect(reviewed).toMatchObject({ ready: true, blockers: [] });
      expect(reviewed.targets).toEqual([
        { nodeId: "a", source: "default", ...ladder, judgmentTarget: haikuJudge },
        // The coordinator's own choices stay as written: no default retries or judge.
        {
          nodeId: "b",
          source: "target",
          target: on(claudeInstanceId, claudeModel),
          judgmentTarget: on(claudeInstanceId, claudeModel),
        },
        { nodeId: "c", source: "default", ...ladder },
      ]);
      expect(reviewed.advisory?.assignmentNotes).toEqual([
        "b judgment: same model family as its worker (claude) while another family is enabled.",
      ]);
      // The expanded graph names every default, so it hashes the same.
      const expanded = yield* reviewGraph(reviewed.expandedGraph);
      expect(expanded.digest).toBe(reviewed.digest);
      expect(expanded.targets.map((entry) => entry.source)).toEqual(["target", "target", "target"]);
      // Without them the same graph is another assignment, so the digest differs.
      const explicit = yield* reviewGraph({
        ...graph,
        nodes: { ...graph.nodes, c: node({ subject: "third", target: ladder.target }) },
      });
      expect(explicit.digest).not.toBe(reviewed.digest);
      const record = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
        parentThreadId,
      )).turnItems.find(
        (item) => item.type === "workflow_review" && item.reviewId === reviewed.reviewId,
      );
      expect(record?.type === "workflow_review" ? record.tasks[0] : undefined).toMatchObject({
        key: "a",
        worker: { providerInstanceId: instanceId, model: MINI, effort: "low" },
        retries: [
          { providerInstanceId: instanceId, model: MINI, effort: "high" },
          { providerInstanceId: instanceId, model, effort: "high" },
        ],
        judge: { providerInstanceId: claudeInstanceId, model: HAIKU, effort: "medium" },
        check: "judgment",
      });
    }).pipe(Effect.provide(layerPriced)),
  );

  it.effect("graph_start of the expanded graph runs them and reports default as the source", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents(passingChecker);
      const reviewed = yield* reviewGraph(graph);
      const started = yield* decodeWorkflow(
        (yield* invoke("graph_start", {
          graph: reviewed.expandedGraph,
          acceptedDigest: reviewed.digest,
        })).structuredContent,
      );
      expect((yield* awaitWorkflowEnd(started.workflowId)).status).toBe("completed");
      const row = (yield* childTasks).find((task) => task.id === started.workflowId)!;
      expect(
        row.workflow?.plan?.nodes.map((entry) => [
          entry.key,
          entry.targetSource,
          entry.checkTargetSource,
        ]),
      ).toEqual([
        ["a", "default", "default"],
        ["b", "target", "target"],
        ["c", "default", undefined],
      ]);
      expect(
        row.workflow?.agents
          .map((agent) => [agent.label, agent.targetSource, agent.model])
          .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["check first", "default", HAIKU],
        ["check second", "target", claudeModel],
        ["first", "default", MINI],
        ["second", "target", claudeModel],
        ["third", "default", MINI],
      ]);
      // The t3 CLI's workflow-report reads this, so it shows default as each one's target source.
      const report = yield* withServerProcess((service) =>
        service.workflowReport(invocation, { threadId: parentThreadId }),
      );
      expect(
        report.workflows[0]?.agents.filter((agent) => agent.targetSource === "default"),
      ).toHaveLength(3);
    }).pipe(Effect.provide(layerPriced)),
  );

  it.effect("without list prices T3 sets none and says so", () =>
    Effect.gen(function* () {
      yield* startParent;
      const reviewed = yield* reviewGraph({
        schemaVersion: 1,
        nodes: { a: node({ verify: judgment }) },
      });
      expect(reviewed.targets).toEqual([
        {
          nodeId: "a",
          source: "caller",
          target: { providerInstanceId: instanceId, model, options: [], inheritOptions: false },
          judgmentTarget: {
            providerInstanceId: instanceId,
            model,
            options: [],
            inheritOptions: false,
          },
        },
      ]);
      expect(reviewed.advisory?.assignmentNotes?.[0]).toContain("No list prices are at hand");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("sets no default judge when no other family is enabled, and says so", () =>
    Effect.gen(function* () {
      yield* startParent;
      const reviewed = yield* decodeReview(
        (yield* invoke("graph_review", {
          graph: { schemaVersion: 1, nodes: { a: node({ verify: judgment }) } },
        })).structuredContent,
      );
      expect(reviewed.ready).toBe(true);
      expect(reviewed.targets).toEqual([
        { nodeId: "a", source: "default", ...ladder, judgmentTarget: ladder.target },
      ]);
      expect(reviewed.advisory?.assignmentNotes).toEqual([`a judgment: ${NO_DEFAULT_JUDGE_NOTE}`]);
    }).pipe(Effect.provide(layerOneFamily)),
  );

  it.effect("a script freezes them at start, keeps its keys and resumes on the same ones", () =>
    Effect.gen(function* () {
      yield* startParent;
      const workflowId = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          const started = yield* service.workflowStart(invocation, {
            script: 'return await agent("x")',
          });
          yield* awaitMember(started.workflowId, 1);
          return started.workflowId;
        }),
      );
      const row = (yield* childTasks).find((task) => task.id === workflowId)!;
      expect(parseStoredWorkflowScript(row.prompt).defaultRouting).toMatchObject(ladder);
      yield* withServerProcess((service) =>
        Effect.gen(function* () {
          yield* service.resumeWorkflows;
          const first = yield* awaitMember(workflowId, 1);
          yield* completeChild(first.childThreadId!, "done");
          expect((yield* awaitWorkflowEnd(workflowId)).status).toBe("completed");
        }),
      );
      const members = (yield* childTasks).filter((task) => task.parentNodeId === workflowId);
      expect(members.map((task) => task.model)).toEqual([MINI]);
      const agent = (yield* childTasks).find((task) => task.id === workflowId)!.workflow!
        .agents[0]!;
      // The key is the one this call had before defaults existed.
      expect([agent.requestKey, agent.targetSource, agent.effort]).toEqual([
        "wf-c585ef6a4b3b95ec597f40fb-0",
        "default",
        "low",
      ]);
    }).pipe(Effect.provide(layerPriced)),
  );
});

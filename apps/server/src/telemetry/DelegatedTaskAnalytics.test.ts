import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as DelegatedTaskAnalytics from "./DelegatedTaskAnalytics.ts";

const threadId = ThreadId.make("thread:analytics");
const workflowId = NodeId.make("workflow:analytics");
const now = DateTime.makeUnsafe("2026-10-23T00:00:10.000Z");
const row = {
  id: workflowId,
  threadId,
  origin: "app_owned",
  status: "completed",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  startedAt: DateTime.makeUnsafe("2026-10-23T00:00:00.000Z"),
  completedAt: now,
} as unknown as OrchestrationV2Subagent;

const harness = (recorded: Array<[string, unknown]>) =>
  DelegatedTaskAnalytics.layer.pipe(
    Layer.provide(
      Layer.succeed(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.never,
        getThreadShell: () => Effect.succeed(null),
        getThreadRecords: () => Effect.succeed({ subagents: [row] }),
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
    ),
    Layer.provide(
      Layer.succeed(AnalyticsService.AnalyticsService, {
        record: (event: string, properties?: unknown) =>
          Effect.sync(() => {
            recorded.push([event, properties]);
          }),
      } as unknown as AnalyticsService.AnalyticsService["Service"]),
    ),
  );

describe("DelegatedTaskAnalytics", () => {
  it.effect("reports a workflow that finishes through a patch, once", () => {
    const recorded: Array<[string, unknown]> = [];
    return Effect.gen(function* () {
      const analytics = yield* DelegatedTaskAnalytics.DelegatedTaskAnalytics;
      const update = {
        id: EventId.make("event:analytics"),
        type: "workflow.updated" as const,
        threadId,
        occurredAt: now,
        payload: {
          id: workflowId,
          previousRevision: 3,
          revision: 4,
          status: "completed" as const,
          updatedAt: now,
        },
      };
      yield* analytics.onWorkflowUpdate({
        ...update,
        payload: { ...update.payload, status: undefined, previousRevision: 2, revision: 3 },
      });
      expect(recorded).toEqual([]);
      yield* analytics.onWorkflowUpdate(update);
      yield* analytics.onWorkflowUpdate(update);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]![0]).toBe("mcp.delegated_task.finished");
      expect(recorded[0]![1]).toMatchObject({ status: "completed", durationSeconds: 10 });
    }).pipe(Effect.provide(harness(recorded)));
  });
});

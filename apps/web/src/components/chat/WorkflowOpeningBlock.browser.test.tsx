import type {
  RuntimeSubagent,
  WorkflowGraphView,
  WorkflowOpening,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ProviderInstanceId, NodeId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { act, fakeTimers, render } from "../../../test/render";
import type ChatMarkdown from "../ChatMarkdown";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";
import { WorkflowWaveCanvas } from "./WorkflowWaveCanvas";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));
vi.mock(import("../ChatMarkdown"), async () => {
  const { memo } = await import("react");
  return {
    default: memo(({ text }: ComponentProps<typeof ChatMarkdown>) => <pre>{text}</pre>),
  };
});

const opening: WorkflowOpening = {
  messageId: "workflow-result",
  name: "Script workflow",
  description: null,
  script: "return result;",
  driver: null,
  providerInstanceId: null,
  group: null,
};

function retryGraph(running = false) {
  return deriveWorkflowGroups(
    projectedSubagentsToRuntime([
      {
        id: "workflow",
        title: "Retry",
        prompt: "",
        model: null,
        status: running ? "running" : "completed",
        result: null,
        startedAt: DateTime.makeUnsafe(0),
        completedAt: DateTime.makeUnsafe(20000),
        updatedAt: DateTime.makeUnsafe(20000),
        workflow: {
          phases: [],
          plan: { nodes: [{ key: "audit", label: "Audit", wave: 0, dependsOn: [] }] },
          agents: [
            {
              index: 0,
              label: "Audit",
              state: running ? "running" : "completed",
              graphNodeKey: "audit",
              attempt: 1,
              childThreadId: ThreadId.make("latest"),
              model: "model-b",
              providerInstanceId: ProviderInstanceId.make("provider-b"),
              totalTokens: 100,
              attemptHistory: [
                {
                  taskId: NodeId.make("old-task"),
                  childThreadId: ThreadId.make("earlier"),
                  attempt: 0,
                  state: "failed",
                  model: "model-a",
                  providerInstanceId: ProviderInstanceId.make("provider-a"),
                  totalTokens: 40,
                  usageStatus: "complete",
                  durationMs: 2000,
                  timingComplete: true,
                },
                {
                  taskId: NodeId.make("new-task"),
                  childThreadId: ThreadId.make("latest"),
                  attempt: 1,
                  state: running ? "running" : "completed",
                  model: "model-b",
                  providerInstanceId: ProviderInstanceId.make("provider-b"),
                  totalTokens: 60,
                  usageStatus: "complete",
                  durationMs: 3000,
                  timingComplete: !running,
                  ...(running ? { activeStartedAt: 10000, completedDurationMs: 500 } : {}),
                },
              ],
            },
          ],
        },
      },
    ]),
  )[0]!.graph!;
}

it("ticks running attempt totals with the shared clock and stops after completion", async () => {
  const onOpenThread = vi.fn();
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={retryGraph()}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={onOpenThread}
    />,
  );
  using _timers = fakeTimers();
  vi.setSystemTime(11000);
  await screen.rerender(
    <WorkflowWaveCanvas
      graph={retryGraph(true)}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={onOpenThread}
    />,
  );
  await expect.element(screen.getByText("≥100 tokens · ≥3.5s", { exact: true })).toBeVisible();
  await act(() => vi.advanceTimersByTime(1000));
  await expect.element(screen.getByText("≥100 tokens · ≥4.5s", { exact: true })).toBeVisible();
  const card = screen.getByRole("button", { name: "Open Audit", exact: true });
  card.element().focus();
  await screen.rerender(
    <WorkflowWaveCanvas
      graph={retryGraph()}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={onOpenThread}
    />,
  );
  await expect.element(card).toHaveFocus();
  await act(() => vi.advanceTimersByTime(10000));
  await expect.element(screen.getByText("100 tokens · 5.0s", { exact: true })).toBeVisible();
});

it("shows summed usage and both attempts in the tooltip and opens earlier children by pointer", async () => {
  const onOpenThread = vi.fn();
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={retryGraph()}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={onOpenThread}
    />,
  );
  const latest = screen.getByRole("button", { name: "Open Audit", exact: true });
  await expect
    .element(latest)
    .toHaveAccessibleDescription(expect.stringContaining("100 tokens · 5.0s"));
  await userEvent.hover(latest);
  await expect.element(page.getByText("Attempt 1: failed", { exact: true })).toBeVisible();
  await expect.element(page.getByText("provider-a / model-a", { exact: true })).toBeVisible();
  await userEvent.click(latest);
  expect(onOpenThread).toHaveBeenLastCalledWith("latest");
  await userEvent.click(screen.getByRole("button", { name: "Attempts for Audit" }));
  await userEvent.click(page.getByRole("button", { name: "Open attempt 1" }));
  expect(onOpenThread).toHaveBeenLastCalledWith("earlier");
  await userEvent.click(page.getByRole("button", { name: "Open attempt 2" }));
  expect(onOpenThread).toHaveBeenLastCalledWith("latest");
});

it("opens current and earlier attempts by keyboard and restores history-trigger focus", async () => {
  const onOpenThread = vi.fn();
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={retryGraph()}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={onOpenThread}
    />,
  );
  await userEvent.tab();
  await expect
    .element(screen.getByRole("button", { name: "Open Audit", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(onOpenThread).toHaveBeenLastCalledWith("latest");
  await userEvent.tab();
  const history = screen.getByRole("button", { name: "Attempts for Audit" });
  await expect.element(history).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("button", { name: "Open attempt 1" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(onOpenThread).toHaveBeenLastCalledWith("earlier");
  await userEvent.keyboard("{Escape}");
  await expect.element(history).toHaveFocus();
});

it("reveals and refolds the complete long result with the keyboard", async () => {
  const progress = `Script output\n${"  untouched <data> & `code`\n".repeat(500)}FINAL RESULT`;
  const container = document.createElement("div");
  container.style.width = "400px";
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={opening}
      environmentId={EnvironmentId.make("test")}
      progress={progress}
      onOpenThread={() => {}}
    />,
    { container },
  );
  const reveal = screen.getByRole("button", { name: "Show full result" });
  await expect.element(reveal).toBeVisible();
  const content = screen.getByText(progress, { exact: true }).element();
  expect(content.textContent).toBe(progress);
  expect(content.clientHeight).toBeLessThan(content.scrollHeight);

  await userEvent.tab();
  await expect.element(reveal).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const collapse = screen.getByRole("button", { name: "Show less", expanded: true });
  await expect.element(collapse).toHaveFocus();
  await expect.element(collapse).toBeVisible();
  expect(content.clientHeight).toBe(content.scrollHeight);
  expect(getComputedStyle(content).whiteSpace).toBe("pre-wrap");
  expect(content.textContent).toBe(progress);

  await userEvent.keyboard(" ");
  await expect.element(reveal).toHaveFocus();
  await expect.element(reveal).toHaveAttribute("aria-expanded", "false");
  expect(content.clientHeight).toBeLessThan(content.scrollHeight);
  expect(content.textContent).toBe(progress);
});

it("keeps a concise failure summary readable without a disclosure", async () => {
  const progress = "Graph failed: Audit: permission denied. 2 nodes skipped.";
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={opening}
      environmentId={EnvironmentId.make("test")}
      progress={progress}
      onOpenThread={() => {}}
    />,
  );
  await expect.element(screen.getByText(progress, { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Show full result" }))
    .not.toBeInTheDocument();
});

it("lets keyboard users inspect a checker with no child thread", async () => {
  const reason = "The selected provider refused to start the checker.";
  const checker: RuntimeSubagent = {
    id: "checker",
    kind: "workflow_agent",
    title: "Audit checker",
    role: null,
    model: "full-model-identity-that-does-not-fit-in-the-card",
    providerInstanceId: ProviderInstanceId.make("review-provider"),
    effort: null,
    status: "failed",
    activationCount: 0,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: reason,
    outputFile: null,
    parentAgentId: null,
    agentIndex: 1,
    phaseIndex: null,
    phaseTitle: null,
    attempt: 0,
    workflowName: null,
    phases: [],
    runHandles: null,
    childThreadId: null,
    recentActivity: [],
    judgmentFor: { agentIndex: 0, attempt: 0, graphNodeKey: "audit" },
    firstSeenAt: "2026-10-23T00:00:00Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-23T00:00:00Z",
  };
  const graph: WorkflowGraphView<RuntimeSubagent> = {
    waves: [
      [
        {
          key: "audit",
          label: "Audit",
          wave: 0,
          dependsOn: [],
          dependents: [],
          state: "failed",
          reason,
          attempts: 1,
          member: null,
          checkers: [checker],
        },
      ],
    ],
    counts: { failed: 1 },
    waitingOn: null,
    otherMembers: [],
  };
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={graph}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  await userEvent.tab();
  await expect.element(screen.getByRole("group", { name: "Audit", exact: true })).toHaveFocus();
  await userEvent.tab();
  const trigger = screen.getByRole("group", { name: "Audit checker", exact: true });
  await expect.element(trigger).toHaveFocus();
  await expect
    .element(trigger)
    .toHaveAccessibleDescription(
      `Check attempt 1: failed · review-provider / ${checker.model} · ${reason}`,
    );
  const popup = page.getByText("Audit checker: Check attempt 1: failed", { exact: false });
  await expect.element(popup).toBeVisible();
  expect(popup.element().textContent).toContain(checker.model);
  await expect.element(page.getByRole("paragraph").filter({ hasText: reason })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(popup).not.toBeInTheDocument();
});

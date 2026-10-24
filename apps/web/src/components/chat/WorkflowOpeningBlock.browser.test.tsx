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

it("shows exact recorded usage, partial usage and budget overshoot honestly", async () => {
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={{
        ...opening,
        budget: { spent: 120, limit: 100, complete: false, exhausted: true, overshot: true },
      }}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  await expect
    .element(screen.getByText("At least 120 tokens recorded / 100 token budget", { exact: true }))
    .toBeVisible();
  await expect
    .element(
      screen.getByText(
        "Budget exceeded. The budget stops new starts. Already-running agents may exceed it. Usage is incomplete.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect
    .element(screen.getByRole("progressbar", { name: "Recorded workflow token usage" }))
    .toHaveAttribute("value", "100");
  await screen.rerender(
    <WorkflowOpeningBlock
      opening={{
        ...opening,
        budget: { spent: null, limit: 100, complete: false, exhausted: false, overshot: false },
      }}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  await expect
    .element(screen.getByText("Unknown usage / 100 token budget", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("progressbar")).not.toBeInTheDocument();
});

function retryGroup(running = false) {
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
  )[0]!;
}

function retryGraph(running = false) {
  return retryGroup(running).graph!;
}

function scriptGroup() {
  return deriveWorkflowGroups(
    projectedSubagentsToRuntime([
      {
        id: "script-workflow",
        title: "State audit",
        prompt: "",
        model: null,
        status: "running",
        result: null,
        startedAt: DateTime.makeUnsafe(0),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe(1000),
        workflow: {
          phases: [],
          agents: [
            {
              index: 0,
              label: "Read files",
              state: "running",
              phaseIndex: 0,
              phaseTitle: "Research",
              childThreadId: ThreadId.make("reader"),
              model: "model-a",
              providerInstanceId: ProviderInstanceId.make("provider-a"),
            },
          ],
        },
      },
    ]),
  )[0]!;
}

// Long enough that the retired folded renderer would also have offered "Show full script".
function longSource(marker: string) {
  return [
    "export const meta = { name: 'state' };",
    ...Array.from({ length: 60 }, (_, line) => `await agent("${marker} ${line}");`),
  ].join("\n");
}

function expectNoScript(root: HTMLElement, marker: string) {
  expect(root.textContent).not.toContain(marker);
  expect(root.textContent).not.toContain("export const meta");
  expect(root.querySelector("pre, code")).toBeNull();
  expect(root.textContent).not.toMatch(/show (full )?script/i);
}

it("keeps a 150-node canvas and card height stable during checks and scrolling", async () => {
  const seed = retryGraph();
  const node = seed.waves[0]![0]!;
  const checker = {
    ...node.member!,
    id: "checker",
    title: "Independent check",
    judgmentFor: { agentIndex: 0, attempt: 0 },
  };
  const graph = (checking: boolean): typeof seed => ({
    ...seed,
    waves: Array.from({ length: 15 }, (_, wave) =>
      Array.from({ length: 10 }, (_, row) => ({
        ...node,
        key: `${wave}-${row}`,
        wave,
        label: `Audit ${wave}-${row} 日本語 🧪 ${"long result ".repeat(20)}`,
        checkers: checking
          ? Array.from({ length: 8 }, (_, index) => ({
              ...checker,
              id: `checker-${wave}-${row}-${index}`,
            }))
          : [],
      })),
    ),
  });
  const container = document.createElement("div");
  container.style.width = "736px";
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={graph(false)}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
    { container },
  );
  const region = screen.getByRole("region", { name: "Workflow graph" });
  await expect.element(region).toBeVisible();
  const element = region.element();
  const height = element.getBoundingClientRect().height;
  const cards = [...element.querySelectorAll("[data-workflow-node]")];
  expect(cards).toHaveLength(150);
  const cardHeight = cards[0]!.getBoundingClientRect().height;
  await screen.rerender(
    <WorkflowWaveCanvas
      graph={graph(true)}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  expect(element.getBoundingClientRect().height).toBe(height);
  expect(
    [...element.querySelectorAll("[data-workflow-node]")].every(
      (card) => card.getBoundingClientRect().height === cardHeight,
    ),
  ).toBe(true);
  // Only cards in view are drawn in full; the rest are placeholders that keep label and state.
  const full = () =>
    element.querySelectorAll("[data-workflow-node]:not([data-workflow-node-placeholder])").length;
  expect(full()).toBeGreaterThan(0);
  expect(full()).toBeLessThan(150);
  const far = element.querySelector('[data-workflow-node="14-9"]')!;
  expect(far.hasAttribute("data-workflow-node-placeholder")).toBe(true);
  expect(far.getAttribute("aria-label")).toContain("Audit 14-9");
  element.scrollTo({ top: element.scrollHeight, left: element.scrollWidth });
  expect(element.scrollLeft).toBeGreaterThan(0);
  expect(element.scrollTop).toBeGreaterThan(0);
  expect(element.getBoundingClientRect().height).toBe(height);
  await expect
    .poll(() =>
      element
        .querySelector('[data-workflow-node="14-9"]')!
        .hasAttribute("data-workflow-node-placeholder"),
    )
    .toBe(false);
  expect(
    element
      .querySelector('[data-workflow-node="0-0"]')!
      .hasAttribute("data-workflow-node-placeholder"),
  ).toBe(true);
  expect(
    [...element.querySelectorAll("[data-workflow-node]")].every(
      (card) => card.getBoundingClientRect().height === cardHeight,
    ),
  ).toBe(true);
});

it("keeps a focused card drawn when it scrolls away and draws a placeholder on focus", async () => {
  const node = retryGraph().waves[0]![0]!;
  const graph = {
    ...retryGraph(),
    waves: Array.from({ length: 15 }, (_, wave) =>
      Array.from({ length: 10 }, (_, row) => ({
        ...node,
        key: `${wave}-${row}`,
        wave,
        label: `Audit ${wave}-${row}`,
        dependsOn: wave === 0 ? [] : [`${wave - 1}-${row}`],
        dependents: wave === 14 ? [] : [`${wave + 1}-${row}`],
      })),
    ),
  };
  const container = document.createElement("div");
  container.style.width = "736px";
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={graph}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
    { container },
  );
  const region = screen.getByRole("region", { name: "Workflow graph" });
  await expect.element(region).toBeVisible();
  const element = region.element();
  const card = (key: string) => element.querySelector(`[data-workflow-node="${key}"]`)!;
  // Focus the first card, then scroll it far out of view.
  const first = card("0-0").querySelector<HTMLElement>("[data-node-state]")!;
  first.focus();
  await expect
    .poll(() => card("0-1").querySelector("[data-node-state]")?.getAttribute("data-node-related"))
    .toBe("false");
  element.scrollTo({ top: element.scrollHeight, left: element.scrollWidth });
  await expect.poll(() => card("0-1").hasAttribute("data-workflow-node-placeholder")).toBe(true);
  expect(card("0-0").hasAttribute("data-workflow-node-placeholder")).toBe(false);
  expect(document.activeElement).toBe(first);
  // The highlight stays with the focused card: its dependent stays lit, unrelated nodes dim.
  expect(card("1-0").className).not.toContain("opacity-35");
  expect(card("5-5").className).toContain("opacity-35");
  // Focusing a placeholder draws that card in full and moves focus to its main control.
  const placeholder = card("0-5");
  expect(placeholder.hasAttribute("data-workflow-node-placeholder")).toBe(true);
  (placeholder as HTMLElement).focus();
  await expect.poll(() => card("0-5").hasAttribute("data-workflow-node-placeholder")).toBe(false);
  expect(document.activeElement).toBe(card("0-5").querySelector("[data-node-state]"));
});

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

it("keeps a script workflow's script out of the timeline block and its phases usable", async () => {
  const marker = "SCRIPT_BODY_MARKER";
  const onOpenThread = vi.fn();
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={{ ...opening, script: longSource(marker), group: scriptGroup() }}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={onOpenThread}
    />,
  );
  await expect.element(screen.getByRole("region", { name: "Research phase" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open Read files" }));
  expect(onOpenThread).toHaveBeenLastCalledWith("reader");
  expectNoScript(screen.container, marker);
});

it("never shows the generated runner of a graph workflow", async () => {
  const marker = "GENERATED_RUNNER_MARKER";
  const onOpenThread = vi.fn();
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={{ ...opening, script: longSource(marker), group: retryGroup() }}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={onOpenThread}
    />,
  );
  await expect.element(screen.getByRole("region", { name: "Workflow graph" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open Audit", exact: true }));
  expect(onOpenThread).toHaveBeenLastCalledWith("latest");
  expectNoScript(screen.container, marker);
});

it("shows no script before the workflow's agents have loaded", async () => {
  const marker = "UNLOADED_SCRIPT_MARKER";
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={{ ...opening, script: longSource(marker) }}
      environmentId={EnvironmentId.make("test")}
      progress="Reading files"
      onOpenThread={() => {}}
    />,
  );
  await expect.element(screen.getByText("Script workflow", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Reading files", { exact: true })).toBeVisible();
  expectNoScript(screen.container, marker);
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

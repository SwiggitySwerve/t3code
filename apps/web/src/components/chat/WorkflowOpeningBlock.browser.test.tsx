import type {
  RuntimeSubagent,
  WorkflowGraphView,
  WorkflowOpening,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  appWorkflowHeading,
  deriveWorkflowProgress,
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
  resolveWorkflowOpening,
  workflowMemberIdentity,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  NodeId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { searchableWorkflowOpeningSegments } from "@t3tools/shared/workflowOpeningText";
import * as DateTime from "effect/DateTime";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { workflowClientSettings } from "../../../test/workflow-fixtures/settings";
import { expandWorkflowPhases } from "../../../test/workflow-fixtures/interactions";
import { persistClientSettingsPatch } from "../../hooks/useSettings";
import { act, fakeTimers, render } from "../../../test/render";
import type ChatMarkdown from "../ChatMarkdown";
import { collectThreadFindRanges } from "./threadFindHighlights";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";
import { WorkflowWaveCanvas } from "./WorkflowWaveCanvas";
import { scrollWavesToNode } from "../../../test/workflow-fixtures/surfaces";
import {
  workflowScaleFixture,
  workflowScriptProgressFixture,
  workflowCallbackLifecycleFixture,
  type WorkflowCallbackState,
} from "../../../test/workflow-fixtures/workflowFixtures";

vi.mock(import("@effect/atom-react"), async (original) => {
  const providers: ReadonlyArray<never> = [];
  return {
    ...(await original()),
    // Applies the selector to no providers, as the avatar reads its name and icon through one.
    useAtomValue: ((_atom: unknown, select?: (value: unknown) => unknown) =>
      select === undefined ? providers : select(providers)) as never,
  };
});

it.each([
  ["graph", 256],
  ["graph", 1024],
  ["script", 256],
  ["script", 1024],
] as const)("updates one selected agent in the %s overview of %i agents", async (kind, count) => {
  const before = workflowScaleFixture(kind, count);
  const after = workflowScaleFixture(kind, count, true);
  const progress = deriveWorkflowProgress(before.group);
  expect(progress.counts).toMatchObject({
    done: count / 2,
    running: count / 4,
    failed: 1,
    queued: count / 4 - 1,
    settled: count / 2 + 1,
    observed: count,
    total: kind === "graph" ? count : null,
  });
  expect(before.row.workflow!.agents[0]!.attemptHistory).toHaveLength(3);
  const view = (fixture: typeof before) => (
    <WorkflowOpeningBlock
      opening={fixture.opening}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />
  );
  using _settings = workflowClientSettings(true);
  await using screen = await render(view(before));
  await expandWorkflowPhases(screen);
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(count);
  const selected = screen.getByRole("button", { name: `Open Agent ${count / 2 + 1}`, exact: true });
  await expect.element(selected).toHaveAccessibleDescription(expect.stringContaining("running"));
  using _timers = fakeTimers();
  await screen.rerender(view(after));
  await act(() => vi.advanceTimersByTime(999));
  await expect.element(selected).toHaveAccessibleDescription(expect.stringContaining("running"));
  await act(() => vi.advanceTimersByTime(1));
  await expect.element(selected).toHaveAccessibleDescription(expect.stringContaining("done"));
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(count);
  expect(screen.container.querySelector("[data-workflow-waves]")).toBeNull();
  if (kind === "graph") {
    await expect
      .element(screen.getByRole("progressbar", { name: "Workflow tasks settled", exact: true }))
      .toHaveAttribute("value", String(count / 2 + 2));
  } else {
    await expect
      .element(screen.getByRole("progressbar", { name: "Workflow tasks settled", exact: true }))
      .toHaveAttribute("max", String(count));
    expect(screen.container.textContent).toContain("total unknown");
  }
});

it.each([256, 1024] as const)(
  "keeps %i direct-canvas nodes accessible while windowing full cards",
  async (count) => {
    const before = workflowScaleFixture("graph", count);
    const after = workflowScaleFixture("graph", count, true);
    const onOpenThread = vi.fn();
    const view = (fixture: typeof before) => (
      <div style={{ width: 736 }}>
        <WorkflowWaveCanvas
          graph={fixture.group.graph!}
          environmentId={EnvironmentId.make("test")}
          onOpenThread={onOpenThread}
        />
      </div>
    );
    using _settings = workflowClientSettings(true);
    await using screen = await render(view(before));
    expect(screen.container.querySelectorAll("[data-workflow-node]")).toHaveLength(count);
    expect(
      screen.container.querySelectorAll("[data-workflow-node-placeholder]").length,
    ).toBeGreaterThan(0);
    const selectedKey = `task-${count / 2}`;
    await scrollWavesToNode(screen.container, selectedKey);
    await userEvent.click(
      screen.getByRole("button", { name: `Open Agent ${count / 2 + 1}, running`, exact: true }),
    );
    expect(onOpenThread).toHaveBeenLastCalledWith(`qa-thread-${count / 2}`);
    await screen.rerender(view(after));
    await expect
      .element(
        screen.getByRole("button", { name: `Open Agent ${count / 2 + 1}, passed`, exact: true }),
      )
      .toHaveFocus();
    expect(screen.container.querySelectorAll("[data-workflow-node]")).toHaveLength(count);
    expect(
      screen.container.querySelectorAll(
        "[data-workflow-node]:not([data-workflow-node-placeholder])",
      ).length,
    ).toBeLessThan(count);
    await scrollWavesToNode(screen.container, `task-${count - 1}`);
    await userEvent.click(
      screen.getByRole("button", { name: `Open Agent ${count}, failed`, exact: true }),
    );
    expect(onOpenThread).toHaveBeenLastCalledWith(`qa-thread-${count - 1}`);
    await expect
      .element(
        screen.getByText("Access denied. Check workspace permissions.", { exact: true }).first(),
      )
      .toBeVisible();
  },
);
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

it.each([4, 40, 256, 1024] as const)(
  "shows every dot with one tab stop per phase and pages verbose cards for %i agents",
  async (count) => {
    const fixture = workflowScaleFixture("graph", count);
    const onOpenThread = vi.fn();
    using _settings = workflowClientSettings(true);
    await using screen = await render(
      <WorkflowOpeningBlock
        opening={fixture.opening}
        environmentId={EnvironmentId.make("test")}
        onOpenThread={onOpenThread}
        findable
      />,
    );
    await expandWorkflowPhases(screen);
    expect(screen.container.querySelectorAll("[data-workflow-phase]")).toHaveLength(
      count === 1024 ? 32 : count === 256 ? 16 : count === 40 ? 4 : 2,
    );
    expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(count);
    expect(screen.container.querySelectorAll('[data-workflow-dot][tabindex="0"]')).toHaveLength(
      screen.container.querySelectorAll("[data-workflow-phase]").length,
    );
    expect(
      screen.container.querySelectorAll("[data-workflow-phase] [data-workflow-identity]"),
    ).toHaveLength(count);
    expect(screen.container.querySelector("[data-workflow-waves]")).toBeNull();
    expect(screen.container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(screen.container.textContent).not.toContain("These are task instructions");
    // Needs attention lists the failure, so only the announcement repeats it.
    const live = screen.container.querySelector('[aria-live="polite"]')!;
    expect(live.querySelector("p")?.textContent).toBe("Reviewing package exports");
    expect(live.querySelector(".sr-only")?.textContent).toBe(
      `1 agent failed · Agent ${count}: Access denied. Check workspace permissions.`,
    );
    await expect
      .element(screen.getByRole("progressbar", { name: "Workflow tasks settled", exact: true }))
      .toHaveAttribute("max", String(count));
    await expect
      .element(screen.getByRole("progressbar", { name: "Workflow tasks settled", exact: true }))
      .toHaveAttribute("value", String(count / 2 + 1));
    await userEvent.click(screen.getByRole("button", { name: `Open Agent ${count}`, exact: true }));
    expect(onOpenThread).toHaveBeenLastCalledWith(`qa-thread-${count - 1}`);
    await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
    expect(screen.container.querySelectorAll("[data-workflow-node]").length).toBeLessThanOrEqual(
      40,
    );
    if (count === 256) {
      expect(screen.container.querySelector('[aria-label="Phase 3"] h4')?.textContent).toContain(
        "16/16 finished · 8 shown",
      );
      await userEvent.click(screen.getByRole("button", { name: "More graph nodes", exact: true }));
      expect(screen.container.querySelector('[aria-label="Phase 3"] h4')?.textContent).toContain(
        "16/16 finished · 8 shown",
      );
      await expect
        .element(screen.getByRole("region", { name: "Phase 1", exact: true }))
        .not.toBeInTheDocument();
      expect(screen.container.querySelectorAll("[data-workflow-node]").length).toBeLessThanOrEqual(
        40,
      );
      await expect
        .element(screen.getByRole("button", { name: "Open Agent 41, passed", exact: true }))
        .toHaveAccessibleDescription(expect.stringContaining("after Agent 17"));
      await expect
        .element(screen.getByRole("button", { name: "More phases", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(screen.getByRole("region", { name: "Phase 16 phase", exact: true }))
        .toBeVisible();
    }
    if (count === 1024) {
      expect(screen.container.querySelector('[aria-label="Phase 2"] h4')?.textContent).toContain(
        "32/32 finished · 8 shown",
      );
      await userEvent.click(screen.getByRole("button", { name: "More graph nodes", exact: true }));
      expect(screen.container.querySelector('[aria-label="Phase 2"] h4')?.textContent).toContain(
        "32/32 finished · 24 shown",
      );
      expect(screen.container.querySelectorAll("[data-workflow-node]")).toHaveLength(40);
      expect(screen.container.querySelectorAll("[data-workflow-phase]")).toHaveLength(32);
      await expect
        .element(screen.getByRole("region", { name: "Phase 32 phase", exact: true }))
        .toBeVisible();
    }
  },
);

it("pages more than 32 phase groups", async () => {
  const fixture = workflowScaleFixture("script", 40);
  const members = fixture.group.phases.flatMap((phase) => phase.members);
  const group = {
    ...fixture.group,
    phases: members.map((member, index) => ({
      ...fixture.group.phases[0]!,
      index,
      title: `Phase ${index + 1}`,
      members: [
        {
          ...member,
          status: "failed" as const,
        },
      ],
    })),
  };
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={{ ...fixture.opening, group }}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  expect(screen.container.querySelectorAll("[data-workflow-phase]")).toHaveLength(32);
  await userEvent.click(screen.getByRole("button", { name: "More phases", exact: true }));
  expect(screen.container.querySelectorAll("[data-workflow-phase]")).toHaveLength(8);
  await expect
    .element(screen.getByRole("region", { name: "Phase 40 phase", exact: true }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Previous phases", exact: true }));
  await expect
    .element(screen.getByRole("region", { name: "Phase 1 phase", exact: true }))
    .toBeVisible();
});

it("moves through dots by keyboard, preserves focus on updates, and skips the rest on Tab", async () => {
  const fixture = workflowScaleFixture("graph", 1024);
  const open = vi.fn();
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <div style={{ width: 400 }}>
      <WorkflowOpeningBlock
        opening={fixture.opening}
        environmentId={EnvironmentId.make("test")}
        onOpenThread={open}
      />
    </div>,
  );
  await expandWorkflowPhases(screen);
  const first = screen.getByRole("button", { name: "Open Agent 1", exact: true });
  await act(() => first.element().focus());
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(screen.getByRole("button", { name: "Open Agent 2", exact: true }))
    .toHaveFocus();
  const grid = screen.container.querySelector("[data-workflow-dots]")!;
  const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(screen.getByRole("button", { name: `Open Agent ${columns + 2}`, exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{ArrowUp}{ArrowLeft}");
  await expect.element(first).toHaveFocus();
  await userEvent.keyboard("{End}");
  await expect
    .element(screen.getByRole("button", { name: "Open Agent 32", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(open).toHaveBeenLastCalledWith("qa-thread-31");
  await userEvent.tab();
  await expect
    .element(screen.getByRole("button", { name: "Open Agent 33", exact: true }))
    .toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect
    .element(screen.getByRole("button", { name: "Open Agent 32", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{Home}");
  await expect.element(first).toHaveFocus();
  using _timers = fakeTimers();
  await screen.rerender(
    <div style={{ width: 400 }}>
      <WorkflowOpeningBlock
        opening={workflowScaleFixture("graph", 1024, true).opening}
        environmentId={EnvironmentId.make("test")}
        onOpenThread={open}
      />
    </div>,
  );
  await act(() => vi.advanceTimersByTime(1000));
  await expect.element(first).toHaveFocus();
  expect(screen.container.querySelectorAll('[data-workflow-dot][tabindex="0"]')).toHaveLength(32);
});

it("keeps unstarted dots inspectable without opening an unavailable thread", async () => {
  using _settings = workflowClientSettings();
  const fixture = workflowScaleFixture("graph", 4);
  const graph = fixture.group.graph!;
  const group = {
    ...fixture.group,
    graph: {
      ...graph,
      waves: graph.waves.map((wave, index) =>
        index === 0
          ? wave.map((node, index) =>
              index === 0 ? { ...node, state: "queued" as const, member: null } : node,
            )
          : wave,
      ),
    },
  };
  const open = vi.fn();
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={{ ...fixture.opening, group }}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={open}
    />,
  );
  const first = screen.getByRole("button", { name: "Open Agent 1", exact: true });
  await userEvent.tab();
  await act(() => first.element().focus());
  await expect.element(first).toHaveAttribute("aria-disabled", "true");
  await expect
    .element(first)
    .toHaveAccessibleDescription(expect.stringContaining("Thread not available yet"));
  await userEvent.keyboard("{Enter}");
  expect(open).not.toHaveBeenCalled();
  await userEvent.keyboard("{ArrowRight}{Enter}");
  expect(open).toHaveBeenLastCalledWith("qa-thread-1");
});

it("coalesces continuing workflow updates into one polite announcement and preserves unknown totals", async () => {
  const fixture = workflowScaleFixture("script", 4);
  // Elapsed labels read the shared clock on their first mount.
  using _timers = fakeTimers({ now: 10_000 });
  const view = (
    log: string,
    status: RuntimeSubagent["status"] = "running",
    model: string | null = "gpt-6.1-sol",
  ) => (
    <WorkflowOpeningBlock
      opening={{
        ...fixture.opening,
        group: {
          ...fixture.group,
          workflow: { ...fixture.group.workflow, progress: log, status },
          phases: fixture.group.phases.map((phase) => ({
            ...phase,
            members: phase.members
              .filter((member) => member.status !== "failed")
              .map((member) => ({
                ...member,
                startedAt:
                  member.status === "running"
                    ? "1970-01-01T00:00:00.000Z"
                    : "1969-12-31T23:59:59.000Z",
                completedAt: null,
                model: member.status === "running" ? model : member.model,
                status: member.status === "running" ? status : member.status,
              })),
          })),
        },
      }}
      environmentId={EnvironmentId.make("test")}
      progress={log}
      heading={appWorkflowHeading(status)}
      onOpenThread={() => {}}
    />
  );
  using _settings = workflowClientSettings(true);
  await using screen = await render(view("Inspecting packages"));
  expect(screen.getByText("Inspecting packages", { exact: true }).elements()).toHaveLength(1);
  expect(screen.container.querySelector("h3")?.nextElementSibling).toBe(
    screen.container.querySelector('[aria-live="polite"]'),
  );
  const active = screen.getByRole("button", { name: "Open Agent 3", exact: true });
  await expect.element(active).toHaveAccessibleDescription(expect.stringContaining("running"));
  await screen.rerender(view("Reading exports"));
  await act(() => vi.advanceTimersByTime(500));
  await screen.rerender(view("Checking types"));
  expect(screen.container.querySelector('[aria-live="polite"]')?.textContent).toBe(
    "Inspecting packages",
  );
  await act(() => vi.advanceTimersByTime(500));
  expect(screen.container.querySelector('[aria-live="polite"]')?.textContent).toBe(
    "Checking types",
  );

  expect(screen.container.querySelector("progress")?.getAttribute("max")).toBe("3");
  expect(screen.container.textContent).toContain("total unknown");
  const live = screen.container.querySelector('[aria-live="polite"]')!;
  expect(live.querySelector("[data-model-glyph]")).toBeNull();
  await screen.rerender(view(""));
  await act(() => vi.advanceTimersByTime(999));
  expect(live.textContent).toBe("Checking types");
  expect(live.querySelector("[data-model-glyph]")).toBeNull();
  await act(() => vi.advanceTimersByTime(1));
  expect(live.querySelector("[data-model-glyph]")?.getAttribute("data-model-glyph")).toBe(
    "gpt-sol",
  );
  expect(live.textContent).toContain("Phase 2 · 1 running");
  await screen.rerender(view("", "running", "gpt-6-luna"));
  await act(() => vi.advanceTimersByTime(500));
  expect(live.querySelector("[data-model-glyph]")?.getAttribute("data-model-glyph")).toBe(
    "gpt-sol",
  );
  await screen.rerender(view("", "running", null));
  await act(() => vi.advanceTimersByTime(500));
  expect(live.querySelector("[data-model-glyph]")).toBeNull();
  expect(live.querySelector("svg")).not.toBeNull();
  expect(screen.container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  await screen.rerender(view("Coordinator resumed"));
  await act(() => vi.advanceTimersByTime(1000));
  expect(live.textContent).toBe("Coordinator resumed");
  expect(live.querySelector('[role="img"]')).toBeNull();
  await screen.rerender(view("Checking types", "cancelled"));
  await expect.element(screen.getByText("Workflow running", { exact: true })).toBeVisible();
  await act(() => vi.advanceTimersByTime(1000));
  await expect.element(screen.getByText("Workflow stopped", { exact: true })).toBeVisible();
  expect(screen.container.querySelector('[aria-live="polite"]')?.textContent).toContain(
    "Workflow stopped",
  );
  expect(screen.container.querySelector('[aria-live="polite"]')?.textContent).not.toContain(
    "Checking types",
  );
  expect(screen.container.textContent).not.toContain("Checking types");
  expect(active.elements()).toHaveLength(0);
  expect(screen.container.querySelector("[data-workflow-receipt]")).not.toBeNull();
});

it("renders fixed script capacity and resizes only the phase being entered", async () => {
  const view = (entered: boolean) => {
    const { opening } = workflowScriptProgressFixture(entered);
    return (
      <WorkflowOpeningBlock
        opening={opening}
        environmentId={EnvironmentId.make("test")}
        onOpenThread={() => {}}
      />
    );
  };
  using _settings = workflowClientSettings(true);
  await using screen = await render(view(false));
  await expandWorkflowPhases(screen);
  using _timers = fakeTimers();
  const audits = screen.getByRole("region", { name: "Package audits phase", exact: true });
  const followup = screen.getByRole("region", { name: "Follow up phase", exact: true });
  await expect.element(audits).toHaveAccessibleDescription("completed · 2/10 settled · 2 done");
  await expect.element(followup).toHaveAccessibleDescription("planned · 0/4 settled");
  await screen.rerender(view(true));
  await act(() => vi.advanceTimersByTime(999));
  await expect.element(followup).toHaveAccessibleDescription("planned · 0/4 settled");
  await act(() => vi.advanceTimersByTime(1));
  await expect.element(audits).toHaveAccessibleDescription("completed · 2/10 settled · 2 done");
  await expect
    .element(followup)
    .toHaveAccessibleDescription("running · 1/2 settled · 1 failed · 1 running");
  await expect
    .element(screen.getByRole("button", { name: "Open Agent 4", exact: true }))
    .toBeVisible();
});

it.each(["completed", "failed", "stopped"] as const)(
  "waits for callback %s before changing phase status and preserves disclosed dots",
  async (state) => {
    const view = (state: WorkflowCallbackState) => (
      <WorkflowOpeningBlock
        opening={workflowCallbackLifecycleFixture(state).opening}
        environmentId={EnvironmentId.make("test")}
        onOpenThread={() => {}}
      />
    );
    using _settings = workflowClientSettings(true);
    await using screen = await render(view("running"));
    using _timers = fakeTimers();
    const phase = screen.getByRole("region", { name: "Audit phase", exact: true });
    await expect.element(phase).toHaveAccessibleDescription("running · 1/1 settled · 1 done");
    await screen.rerender(view(state));
    await act(() => vi.advanceTimersByTime(999));
    await expect.element(phase).toHaveAccessibleDescription("running · 1/1 settled · 1 done");
    await act(() => vi.advanceTimersByTime(1));
    await expandWorkflowPhases(screen);
    await expect.element(phase).toHaveAccessibleDescription(`${state} · 1/1 settled · 1 done`);
    expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(1);
    if (state === "failed") {
      const live = screen.container.querySelector('[aria-live="polite"]')!;
      expect(live.textContent).toBe("Workflow finished · Audit failed");
      expect(screen.container.querySelector("[data-workflow-receipt]")?.textContent).toContain(
        "1 agent · 1 phase failed",
      );
      expect(live.querySelector("[data-model-glyph]")).toBeNull();
    }
  },
);

it("reveals a declaration search match while keeping the graph unmounted", async () => {
  const fixture = workflowScaleFixture("graph", 256);
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <div data-timeline-row-id="workflow">
      <WorkflowOpeningBlock
        opening={fixture.opening}
        environmentId={EnvironmentId.make("test")}
        onOpenThread={() => {}}
        findable
      />
    </div>,
  );
  const matches = collectThreadFindRanges(screen.container, "Agent 256");
  expect(matches).toHaveLength(1);
  const fold = matches[0]!.range.startContainer.parentElement!.closest("[hidden]")!;
  expect(fold).not.toBeNull();
  await act(() => fold.dispatchEvent(new Event("beforematch")));
  await expect
    .element(screen.getByRole("button", { name: "Workflow declaration", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  expect(screen.container.querySelector("[data-workflow-waves]")).toBeNull();
});

it("shows exact recorded usage, partial usage and budget overshoot honestly", async () => {
  using _settings = workflowClientSettings(true);
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
}

it("grows a card only by its checker rows and keeps the canvas stable while scrolling", async () => {
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
  using _settings = workflowClientSettings(true);
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
  // Eight checker attempts show as two rows (28px each) and scroll inside them; the scroll area
  // itself stays at its maximum height.
  const checkedHeight = cardHeight + 2 * 28;
  expect(element.getBoundingClientRect().height).toBe(height);
  expect(
    [...element.querySelectorAll("[data-workflow-node]")].every(
      (card) => card.getBoundingClientRect().height === checkedHeight,
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
  await vi.waitFor(() => {
    const mask = getComputedStyle(element).maskImage;
    expect(mask).toContain("linear-gradient(to right, rgb(0, 0, 0)");
    expect(mask).toContain("linear-gradient(rgb(0, 0, 0) calc(");
  });
  element.scrollTo({ top: element.scrollHeight, left: element.scrollWidth });
  expect(element.scrollLeft).toBeGreaterThan(0);
  expect(element.scrollTop).toBeGreaterThan(0);
  expect(element.getBoundingClientRect().height).toBe(height);
  await vi.waitFor(() => {
    const mask = getComputedStyle(element).maskImage;
    expect(mask).toContain("linear-gradient(to right, rgba(0, 0, 0, 0)");
    expect(mask).toContain("linear-gradient(rgba(0, 0, 0, 0)");
    expect(mask.split("rgba(0, 0, 0, 0)")).toHaveLength(3);
  });
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
      (card) => card.getBoundingClientRect().height === checkedHeight,
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
  using _settings = workflowClientSettings(true);
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

it("shows recorded attempt totals without a per-card ticker", async () => {
  const onOpenThread = vi.fn();
  using _settings = workflowClientSettings(true);
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
  await expect.element(screen.getByText("≥100 tokens · ≥5.0s", { exact: true })).toBeVisible();
  await act(() => vi.advanceTimersByTime(1000));
  await expect.element(screen.getByText("≥100 tokens · ≥5.0s", { exact: true })).toBeVisible();
  // The card's name carries its state, which changes with the run.
  const card = screen.getByRole("button", { name: /^Open Audit, / });
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
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={retryGraph()}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={onOpenThread}
    />,
  );
  const latest = screen.getByRole("button", { name: "Open Audit, interrupted", exact: true });
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
  using _settings = workflowClientSettings(true);
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
    .element(screen.getByRole("button", { name: "Open Audit, interrupted", exact: true }))
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
  using _settings = workflowClientSettings(true);
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
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={{ ...opening, script: longSource(marker), group: retryGroup() }}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={onOpenThread}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
  await expect.element(screen.getByRole("region", { name: "Workflow graph" })).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Open Audit, interrupted", exact: true }),
  );
  expect(onOpenThread).toHaveBeenLastCalledWith("latest");
  expectNoScript(screen.container, marker);
});

it("shows no script before the workflow's agents have loaded", async () => {
  const marker = "UNLOADED_SCRIPT_MARKER";
  using _settings = workflowClientSettings(true);
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

it.each(["unloaded", "failed", "completed"] as const)(
  "reveals and refolds the complete long result with the keyboard, coordinator=%s",
  async (status) => {
    const progress = `Script output\n${"  untouched <data> & `code`\n".repeat(500)}FINAL RESULT`;
    const container = document.createElement("div");
    container.style.width = "400px";
    using _settings = workflowClientSettings(true);
    await using screen = await render(
      <WorkflowOpeningBlock
        opening={
          status !== "unloaded"
            ? {
                ...opening,
                group: {
                  ...scriptGroup(),
                  phases: [],
                  workflow: {
                    ...scriptGroup().workflow,
                    status,
                    error: status === "failed" ? progress : null,
                    result: progress,
                    progress: "Old running log",
                  },
                },
              }
            : opening
        }
        environmentId={EnvironmentId.make("test")}
        progress={progress}
        onOpenThread={() => {}}
      />,
      { container },
    );
    if (status !== "unloaded") {
      expect(screen.container.textContent).not.toContain("FINAL RESULT");
      expect(screen.container.querySelector('[aria-live="polite"]')?.textContent).toContain(
        status === "completed" ? "Workflow finished" : "Workflow failed",
      );
      expect(screen.container.textContent).not.toContain("Old running log");
      const result = screen.getByRole("button", { name: "Workflow result", exact: true });
      await act(() => result.element().focus());
      await expect.element(result).toHaveFocus();
      await userEvent.keyboard("{Enter}");
    }
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
  },
);

it("keeps a concise failure summary readable without a disclosure", async () => {
  const progress = "Graph failed: Audit: permission denied. 2 nodes skipped.";
  using _settings = workflowClientSettings(true);
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
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={graph}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  await userEvent.tab();
  await userEvent.tab();
  await expect
    .element(screen.getByRole("group", { name: "Audit, failed", exact: true }))
    .toHaveFocus();
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
  // The failed node's own card also shows its reason; the popup's is the last in the document.
  await expect
    .element(page.getByRole("paragraph").filter({ hasText: reason }).last())
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(popup).not.toBeInTheDocument();
});

it("states the reason of a node that failed before it started once", async () => {
  const reason = "Count source files produced no output to pass on.";
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
          checkers: [],
        },
      ],
    ],
    counts: { failed: 1 },
    waitingOn: null,
    otherMembers: [],
  };
  await using _ = await render(
    <WorkflowWaveCanvas
      graph={graph}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  await expect.element(page.getByText(reason, { exact: true })).toBeVisible();
  const card = document.querySelector('[data-workflow-node="audit"]');
  expect(card?.textContent?.split(reason).length).toBe(2);
});

// A card cuts a long label and model with an ellipsis, and a dependent node is dimmed. The full
// text and the state in words must reach assistive technology and show on hover and on focus,
// and colour alone must never be what says a node waits.
const LONG_LABEL =
  "Notes on corpus part one and the cross references between every chapter of the appendix";
const LONG_MODEL = "claude-haiku-5-5-with-a-model-name-too-long-for-the-card";

function cutGraph(): WorkflowGraphView<RuntimeSubagent> {
  const seed = retryGraph().waves[0]![0]!;
  const notes = {
    ...seed,
    key: "notes",
    label: LONG_LABEL,
    wave: 0,
    state: "passed" as const,
    dependsOn: [],
    dependents: ["combine"],
    reason: null,
    attempts: 1,
    checkers: [],
    member: { ...seed.member!, model: LONG_MODEL },
  };
  const combine = {
    ...seed,
    key: "combine",
    label: "Combine the notes",
    wave: 1,
    state: "waiting" as const,
    dependsOn: ["notes"],
    dependents: [],
    reason: null,
    attempts: null,
    checkers: [],
    member: null,
  };
  return {
    waves: [[notes], [combine]],
    counts: { passed: 1, waiting: 1 },
    waitingOn: null,
    otherMembers: [],
  };
}

it("names each card by its full label and its state, and says a dependent node waits in words", async () => {
  const graph = cutGraph();
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={graph}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  const identity = workflowMemberIdentity(graph.waves[0]![0]!.member);
  const notes = screen.getByRole("button", { name: `Open ${LONG_LABEL}, passed`, exact: true });
  await expect.element(notes).toBeVisible();
  await expect.element(notes).toHaveAccessibleDescription(expect.stringContaining(identity));
  const combine = screen.getByRole("group", { name: "Combine the notes, waiting", exact: true });
  await expect.element(combine).toBeVisible();
  // The state is a word on the card; the nodes it runs after sit on their own line.
  expect(combine.element().textContent).toContain("Waiting");
  expect(combine.element().textContent).toContain(`after ${LONG_LABEL}`);
  expect(notes.element().textContent).toContain("Passed");
});

it("shows a cut label, model and state in full when a card is hovered", async () => {
  const graph = cutGraph();
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={graph}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  const identity = workflowMemberIdentity(graph.waves[0]![0]!.member);
  await userEvent.hover(
    screen.getByRole("button", { name: `Open ${LONG_LABEL}, passed`, exact: true }),
  );
  await expect
    .element(page.getByText(`${LONG_LABEL}: passed, ${identity}`, { exact: false }))
    .toBeVisible();
});

it("shows a cut label, model and state in full when a card takes keyboard focus", async () => {
  const graph = cutGraph();
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={graph}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  const identity = workflowMemberIdentity(graph.waves[0]![0]!.member);
  await userEvent.tab();
  await expect.element(screen.getByRole("region", { name: "Workflow graph" })).toHaveFocus();
  await userEvent.tab();
  await expect
    .element(screen.getByRole("button", { name: `Open ${LONG_LABEL}, passed`, exact: true }))
    .toHaveFocus();
  await expect
    .element(page.getByText(`${LONG_LABEL}: passed, ${identity}`, { exact: false }))
    .toBeVisible();
  // Tabbing on reaches the dependent card, named with its state as well. A node that ran once
  // has no history button between the two cards.
  await userEvent.tab();
  await expect
    .element(screen.getByRole("group", { name: "Combine the notes, waiting", exact: true }))
    .toHaveFocus();
});

it("lets the keyboard reach a workflow block's graph, its cards and its Stop", async () => {
  const onStop = vi.fn();
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <>
      <button type="button">Before the block</button>
      <WorkflowOpeningBlock
        opening={{ ...opening, name: "Retry", group: retryGroup(true) }}
        environmentId={EnvironmentId.make("test")}
        onOpenThread={() => {}}
        heading="Workflow running"
        stop={{ onStop, stopping: false, disabled: false }}
      />
    </>,
  );
  const block = screen.container.querySelector("[data-workflow-opening]")!;
  expect(block).not.toBeNull();
  expect(block).toHaveAttribute("aria-label", "Workflow running: Retry");
  await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
  screen.getByRole("button", { name: "Before the block" }).element().focus();
  const stops: Array<string> = [];
  for (let press = 0; press < 10; press += 1) {
    await userEvent.tab();
    const active = document.activeElement;
    if (active !== null && block.contains(active)) {
      stops.push(active.getAttribute("aria-label") ?? active.tagName);
    }
  }
  // The block is in the page's tab order: Stop, the graph region, a card and its attempts.
  expect(stops).toEqual(
    expect.arrayContaining([
      "Workflow graph",
      expect.stringMatching(/^Open Audit, /),
      "Attempts for Audit",
      expect.stringMatching(/^Stop workflow /),
    ]),
  );
});
// Find paints what the server counts: the drawn declaration, never a status line, and nothing at
// all in a block whose thread the server does not index.
function foundText(root: HTMLElement, query: string) {
  return collectThreadFindRanges(root, query).map(({ range }) => range.toString());
}

function declaredGraphGroup() {
  return deriveWorkflowGroups(
    projectedSubagentsToRuntime([
      {
        id: "graph-workflow",
        title: "Quarterly run",
        prompt: "",
        model: null,
        status: "running",
        result: null,
        startedAt: DateTime.makeUnsafe(0),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe(1000),
        workflow: {
          phases: [],
          plan: {
            nodes: [
              { key: "draft", label: "Draft ledger", wave: 0, dependsOn: [] },
              { key: "review", label: "Review ledger", wave: 1, dependsOn: ["draft"] },
            ],
          },
          agents: [
            {
              index: 0,
              label: "Draft ledger",
              state: "running",
              graphNodeKey: "draft",
              childThreadId: ThreadId.make("drafter"),
              model: "model-a",
              providerInstanceId: ProviderInstanceId.make("provider-a"),
            },
          ],
        },
      },
    ]),
  )[0]!;
}

it("finds a script opening's declaration but not its status line", async () => {
  const block = (findable: boolean) => (
    <div data-timeline-row-id="opening">
      <WorkflowOpeningBlock
        opening={{ ...opening, description: "Reconcile ledgers", group: scriptGroup() }}
        environmentId={EnvironmentId.make("test")}
        progress="Reading billing files"
        findable={findable}
        onOpenThread={() => {}}
      />
    </div>
  );
  using _settings = workflowClientSettings(true);
  await using screen = await render(block(true));
  expect(foundText(screen.container, "script workflow")).toEqual(["Script workflow"]);
  expect(foundText(screen.container, "RECONCILE")).toEqual(["Reconcile"]);
  expect(foundText(screen.container, "research")).toEqual(["Research"]);
  expect(foundText(screen.container, "billing")).toEqual([]);
  // The agents inside a phase are not part of the declaration.
  expect(foundText(screen.container, "read files")).toEqual([]);
  await screen.rerender(block(false));
  for (const query of ["script workflow", "reconcile", "research", "billing"]) {
    expect(foundText(screen.container, query), query).toEqual([]);
  }
});

it("finds a graph opening's node labels once, not the line that names the blocking node", async () => {
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <div data-timeline-row-id="opening">
      <WorkflowOpeningBlock
        opening={{ ...opening, group: declaredGraphGroup() }}
        environmentId={EnvironmentId.make("test")}
        findable
        onOpenThread={() => {}}
      />
    </div>,
  );
  await expect.element(screen.getByText("Waiting on Draft ledger", { exact: false })).toBeVisible();
  expect(foundText(screen.container, "draft")).toEqual(["Draft"]);
  expect(foundText(screen.container, "ledger")).toEqual(["ledger", "ledger"]);
  expect(foundText(screen.container, "depends")).toEqual([]);
});

// The server counts find matches from `searchableWorkflowOpeningSegments(row)`; the block draws
// the same row through the client's own path. Every occurrence must land in the same element,
// in the same order, or the counter and the highlighted match disagree.
function coordinatorRow(
  title: string | null,
  workflow: NonNullable<OrchestrationV2Subagent["workflow"]>,
) {
  return {
    id: "coordinator-row",
    title,
    prompt: "export const meta = {}",
    model: null,
    status: "running" as const,
    result: null,
    startedAt: DateTime.makeUnsafe(0),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(1000),
    childThreadId: ThreadId.make("coordinator"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("provider-a"),
    workflow,
  };
}

function drawnOpening(row: ReturnType<typeof coordinatorRow>): WorkflowOpening {
  const parent = ThreadId.make("parent");
  const opening = resolveWorkflowOpening({
    thread: {
      id: ThreadId.make("coordinator"),
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      creationSource: "provider",
    },
    messages: [
      { id: "script", role: "user", text: "export const meta = {}", workflowScript: true },
    ],
    parentSubagents: [row],
  });
  if (opening === null) throw new Error("A script message on a provider subagent thread opens.");
  return opening;
}

const AGREEMENT_ROWS = {
  "a script with declared, guessed and unstarted phases": coordinatorRow("Reconcile ledgers", {
    name: "Quarterly\naudit",
    phases: [
      { index: 1, title: "Second quarter" },
      { index: 3, title: "Unstarted quarter" },
    ],
    agents: [
      { index: 0, label: "Read", state: "running", phaseIndex: 0 },
      { index: 1, label: "Write", state: "queued", phaseIndex: 1 },
      { index: 2, label: "Late", state: "queued", phaseIndex: 2, phaseTitle: "Third quarter" },
      { index: 3, label: "Loose", state: "queued" },
    ],
  }),
  "a graph whose plan lists a later wave first": coordinatorRow("Quarterly audit", {
    phases: [],
    plan: {
      nodes: [
        { key: "b", label: "Beta review", wave: 1, dependsOn: ["a"] },
        { key: "c", label: "Gamma review", wave: 1, dependsOn: ["a"] },
        { key: "a", label: "Alpha review", wave: 0, dependsOn: [] },
      ],
    },
    agents: [],
  }),
  "a coordinator with no workflow detail yet": coordinatorRow(null, { phases: [], agents: [] }),
} satisfies Record<string, ReturnType<typeof coordinatorRow>>;

it.each(Object.entries(AGREEMENT_ROWS))(
  "draws exactly the text the server counts for %s",
  async (_name, row) => {
    const segments = searchableWorkflowOpeningSegments(row);
    using _settings = workflowClientSettings(true);
    await using screen = await render(
      <div data-timeline-row-id="opening">
        <WorkflowOpeningBlock
          opening={drawnOpening(row)}
          environmentId={EnvironmentId.make("test")}
          findable
          onOpenThread={() => {}}
        />
      </div>,
    );
    const drawn = (query: string) =>
      collectThreadFindRanges(screen.container, query).map(({ range }) =>
        range.toString().replace(/\r?\n/g, " "),
      );
    const counted = (query: string) =>
      segments.flatMap((segment) =>
        findThreadSearchOccurrences(segment, query).map((offset) =>
          segment.slice(offset, offset + query.length),
        ),
      );
    for (const query of ["quarter", "audit", "review", "phase", "a", "e", "workflow", "audit "]) {
      expect(drawn(query), query).toEqual(counted(query));
    }
    expect(drawn("quarterly audit")).toEqual(counted("quarterly audit"));
    // The script's own words are in neither.
    expect(drawn("meta")).toEqual([]);
    expect(counted("meta")).toEqual([]);
  },
);

function failedAgentGroup(fields: { progress: string | null; error: string | null }) {
  const group = scriptGroup();
  return {
    ...group,
    phases: group.phases.map((phase) => ({
      ...phase,
      members: phase.members.map((member) => ({
        ...member,
        status: "failed" as const,
        result: null,
        ...fields,
      })),
    })),
  };
}

it("shows a failed agent's error in the headline and never its prompt", async () => {
  const prompt = "Run this command exactly once: ping -n 181 127.0.0.1";
  using _settings = workflowClientSettings(true);
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={{ ...opening, group: failedAgentGroup({ progress: prompt, error: null }) }}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Open Read files" })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Run this command");
  await screen.rerender(
    <WorkflowOpeningBlock
      opening={{
        ...opening,
        group: failedAgentGroup({ progress: prompt, error: "The command exited with code 1." }),
      }}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  await expect
    .element(screen.getByText(/Read files: The command exited with code 1\./))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("Run this command");
});

it("defaults to dots, reacts to the persisted graph preference, and removes the mounted graph when disabled", async () => {
  using _settings = workflowClientSettings();
  const persist = vi.fn(async () => {});
  const fixture = workflowScaleFixture("graph", 4);
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={fixture.opening}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  await expandWorkflowPhases(screen);
  await expect
    .element(screen.getByRole("button", { name: "Graph details", exact: true }))
    .not.toBeInTheDocument();
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(4);
  await act(() => persistClientSettingsPatch({ verboseWorkflowGraph: true }, persist));
  await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
  expect(screen.container.querySelector("[data-workflow-waves]")).not.toBeNull();
  await act(() => persistClientSettingsPatch({ verboseWorkflowGraph: false }, persist));
  expect(screen.container.querySelector("[data-workflow-waves]")).toBeNull();
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(4);
  expect(persist).toHaveBeenLastCalledWith(
    expect.objectContaining({ verboseWorkflowGraph: false }),
  );
});

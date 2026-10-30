import { EnvironmentId } from "@t3tools/contracts";
import {
  deriveWorkflowProgress,
  workflowProgressText,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import { readQaAtom } from "../../../test/workflow-fixtures/atoms";
import { expandWorkflowPhases } from "../../../test/workflow-fixtures/interactions";
import {
  workflowCollapseFixture,
  workflowPlannedIdentityFixture,
} from "../../../test/workflow-fixtures/workflowFixtures";
import { WorkflowBlockSurface } from "../../../test/workflow-fixtures/surfaces";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";
import { WorkflowProgressOverview } from "./WorkflowProgressOverview";
import "../../index.css";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) =>
    readQaAtom(atom, selector)) as never,
}));

it("discloses contiguous done, queued and later running phases locally while keeping two running and failed grids visible", async () => {
  const fixture = workflowPlannedIdentityFixture("graph", 256);
  await using screen = await render(<WorkflowBlockSurface kind="graph" fixture={fixture} />);
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(48);
  await expect
    .element(screen.getByRole("button", { name: /^Phases 11–12 · 32 running/ }))
    .toHaveAttribute("aria-expanded", "false");
  const done = screen.getByRole("button", { name: /Phases 1–8 · 128 done/ });
  await expect.element(done).toHaveAttribute("aria-expanded", "false");
  await expect
    .element(screen.getByRole("button", { name: "Open Agent 256", exact: true }))
    .toBeVisible();
  expect(
    done.element().querySelectorAll("[data-workflow-agent-identity]").length,
  ).toBeLessThanOrEqual(3);
  await userEvent.click(done);
  await expect.element(done).toHaveAttribute("aria-expanded", "true");
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(176);
  await userEvent.click(done);
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(48);
  await expandWorkflowPhases(screen);
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(256);
  for (const cell of screen.container.querySelectorAll("[data-workflow-dot]")) {
    expect(cell.getAttribute("aria-description")).toMatch(/^(done|running|failed|queued),/);
  }
  await expect
    .element(screen.getByRole("button", { name: "Open Agent 200", exact: true }))
    .toHaveAccessibleDescription(expect.stringContaining("Planned"));
});

it("defaults terminal work to a receipt and reveals its complete grids on request", async () => {
  await using screen = await render(
    <WorkflowBlockSurface
      kind="graph"
      fixture={workflowCollapseFixture("graph", 256, "completed")}
    />,
  );
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(0);
  await expect
    .element(screen.getByRole("button", { name: "Show phases", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  const receipt = screen.container.querySelector("[data-workflow-receipt]")?.textContent;
  expect(receipt).toContain("256 agents");
  expect(receipt).not.toContain("failed");
  await expandWorkflowPhases(screen);
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(256);
  await userEvent.click(screen.getByRole("button", { name: "Hide phases", exact: true }));
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(0);
});

it("opens a shared anchored readout from receipt attention entries and discloses overflow", async () => {
  const fixture = workflowCollapseFixture("graph", 4, "failed");
  const graph = fixture.group.graph!;
  const group = {
    ...fixture.group,
    graph: {
      ...graph,
      waves: graph.waves.map((wave) =>
        wave.map((node) => ({ ...node, state: "failed" as const, reason: "Permission denied" })),
      ),
    },
  };
  const open = vi.fn();
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={{ ...fixture.opening, group }}
      environmentId={EnvironmentId.make("qa")}
      onOpenThread={open}
    />,
  );
  expect(screen.container.querySelectorAll("[data-workflow-attention]")).toHaveLength(3);
  await userEvent.click(screen.getByRole("button", { name: "+1 more", exact: true }));
  expect(screen.container.querySelectorAll("[data-workflow-attention]")).toHaveLength(4);
  const entry = screen.getByRole("button", {
    name: "Inspect Agent 4: Permission denied",
    exact: true,
  });
  await userEvent.click(entry);
  const readout = page.getByRole("note", { name: "Agent details" });
  await expect.element(readout).toBeVisible();
  expect(readout.element().textContent).toContain("GPT-6.1 Sol");
  expect(document.querySelectorAll("[data-workflow-readout]")).toHaveLength(1);
  await vi.waitFor(() =>
    expect(
      Math.abs(
        readout.element().getBoundingClientRect().top -
          entry.element().getBoundingClientRect().bottom,
      ),
    ).toBeLessThanOrEqual(8),
  );
  expect(open).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(readout).not.toBeInTheDocument();
});

it("keeps one running phase unchanged and dismisses its readout when completion removes the cell", async () => {
  await using screen = await render(
    <WorkflowBlockSurface kind="graph" fixture={workflowCollapseFixture("graph", 4)} />,
  );
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(4);
  expect(screen.container.querySelector("[data-workflow-phase-disclosure]")).toBeNull();
  expect(screen.container.querySelector("[data-workflow-attention-list]")).toBeNull();
  await act(() =>
    screen.getByRole("button", { name: "Open Agent 1", exact: true }).element().focus(),
  );
  await expect.element(page.getByRole("note", { name: "Agent details" })).toBeVisible();
  using _timers = fakeTimers();
  await screen.rerender(
    <WorkflowBlockSurface
      kind="graph"
      fixture={workflowCollapseFixture("graph", 4, "completed")}
    />,
  );
  await act(() => vi.advanceTimersByTime(1000));
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(0);
  await expect.element(page.getByRole("note", { name: "Agent details" })).not.toBeInTheDocument();
});

it("preserves the focused running grid when earlier completed phases merge", async () => {
  const fixture = workflowCollapseFixture("graph", 40);
  const graph = fixture.group.graph!;
  const view = (completedSecond: boolean) => (
    <WorkflowProgressOverview
      progress={deriveWorkflowProgress({
        ...fixture.group,
        graph: {
          ...graph,
          waves: graph.waves.map((wave, index) =>
            wave.map((node) => ({
              ...node,
              state:
                index === 0 || (index === 1 && completedSecond)
                  ? "passed"
                  : index <= 2
                    ? "running"
                    : "waiting",
            })),
          ),
        },
      })}
      environmentId={EnvironmentId.make("qa")}
      onOpenThread={() => {}}
    />
  );
  await using screen = await render(view(false));
  const selector = `[data-workflow-dot="${graph.waves[2]![0]!.key}"]`;
  const cell = screen.container.querySelector<HTMLButtonElement>(selector)!;
  await act(() => cell.focus());
  expect(document.activeElement).toBe(cell);
  await screen.rerender(view(true));
  expect(screen.container.querySelector(selector)).toBe(cell);
  expect(document.activeElement).toBe(cell);
  await expect.element(page.getByRole("note", { name: "Agent details" })).toBeVisible();
});

it("keeps a disclosed running fold and its focused cell while an earlier phase finishes", async () => {
  const fixture = workflowCollapseFixture("graph", 256);
  const graph = fixture.group.graph!;
  const view = (ninthFinished: boolean) => (
    <WorkflowProgressOverview
      progress={deriveWorkflowProgress({
        ...fixture.group,
        graph: {
          ...graph,
          waves: graph.waves.map((wave, index) =>
            index === 8 && ninthFinished
              ? wave.map((node) => ({ ...node, state: "passed" as const }))
              : wave,
          ),
        },
      })}
      environmentId={EnvironmentId.make("qa")}
      onOpenThread={() => {}}
    />
  );
  await using screen = await render(view(false));
  await userEvent.click(screen.getByRole("button", { name: /^Phases 11–12 · 32 running/ }));
  const cell = (id: string) =>
    screen.container.querySelector<HTMLButtonElement>(`[data-workflow-dot="${id}"]`)!;
  // Phase 11 leaves the fold for its own expanded grid; Phase 12 stays folded.
  const leaving = cell("task-160");
  await act(() => leaving.focus());
  await screen.rerender(view(true));
  expect(document.activeElement).toBe(leaving);
  await screen.rerender(view(false));
  const staying = cell("task-176");
  await act(() => staying.focus());
  await screen.rerender(view(true));
  expect(document.activeElement).toBe(staying);
  await expect
    .element(screen.getByRole("button", { name: /^Phase 12 · 16 running/ }))
    .toHaveAttribute("aria-expanded", "true");
});

it("keeps a focused fold disclosure when an earlier fold of its kind goes away", async () => {
  const fixture = workflowCollapseFixture("graph", 256);
  const graph = fixture.group.graph!;
  // Phases 1–2 hold the running slots, 3 folds, 4 has a failure, 5–6 fold, the rest wait.
  const view = (thirdPassed: boolean) => (
    <WorkflowProgressOverview
      progress={deriveWorkflowProgress({
        ...fixture.group,
        graph: {
          ...graph,
          waves: graph.waves.map((wave, index) =>
            wave.map((node, position) => ({
              ...node,
              state:
                index === 2 && thirdPassed
                  ? ("passed" as const)
                  : index === 3 && position === 0
                    ? ("failed" as const)
                    : index <= 5
                      ? ("running" as const)
                      : ("waiting" as const),
            })),
          ),
        },
      })}
      environmentId={EnvironmentId.make("qa")}
      onOpenThread={() => {}}
    />
  );
  await using screen = await render(view(false));
  const fold = screen.getByRole("button", { name: /^Phases 5–6 · 32 running/ }).element();
  await act(() => (fold as HTMLButtonElement).focus());
  await screen.rerender(view(true));
  await expect
    .element(screen.getByRole("button", { name: /^Phase 3 · 16 done/ }))
    .toBeInTheDocument();
  expect(fold.isConnected).toBe(true);
  expect(document.activeElement).toBe(fold);
});

it.each(["omitted", "normalized"] as const)(
  "suppresses internal graph results in receipts when progress is %s",
  async (mode) => {
    const fixture = workflowCollapseFixture("graph", 4, "completed");
    const result = JSON.stringify({
      ok: true,
      nodes: Object.fromEntries(
        fixture.row.workflow!.plan!.nodes.map((node) => [node.key, { status: "passed" }]),
      ),
    });
    const normalized = workflowProgressText({ ...fixture.row, result });
    expect(normalized).toBeNull();
    await using screen = await render(
      <WorkflowOpeningBlock
        opening={{
          ...fixture.opening,
          group: { ...fixture.group, workflow: { ...fixture.group.workflow, result } },
        }}
        {...(mode === "normalized" ? { progress: normalized } : {})}
        environmentId={EnvironmentId.make("qa")}
        onOpenThread={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Workflow result", exact: true }).elements(),
    ).toHaveLength(0);
  },
);

it("keeps script results and respects an explicitly suppressed terminal result", async () => {
  const fixture = workflowCollapseFixture("script", 4, "completed");
  const opening = {
    ...fixture.opening,
    group: {
      ...fixture.group,
      workflow: { ...fixture.group.workflow, result: "Published the migration report." },
    },
  };
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={opening}
      environmentId={EnvironmentId.make("qa")}
      onOpenThread={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Workflow result", exact: true }));
  await expect
    .element(screen.getByText("Published the migration report.", { exact: true }))
    .toBeVisible();
  using _timers = fakeTimers();
  await screen.rerender(
    <WorkflowOpeningBlock
      opening={opening}
      progress={null}
      environmentId={EnvironmentId.make("qa")}
      onOpenThread={() => {}}
    />,
  );
  await act(() => vi.advanceTimersByTime(1000));
  expect(
    screen.getByRole("button", { name: "Workflow result", exact: true }).elements(),
  ).toHaveLength(0);
});

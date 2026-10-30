import { EnvironmentId } from "@t3tools/contracts";
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
import "../../index.css";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) =>
    readQaAtom(atom, selector)) as never,
}));

it("discloses contiguous done and queued phases locally while keeping running and failed grids visible", async () => {
  const fixture = workflowPlannedIdentityFixture("graph", 256);
  await using screen = await render(<WorkflowBlockSurface kind="graph" fixture={fixture} />);
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(80);
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
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(208);
  await userEvent.click(done);
  expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(80);
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
  expect(screen.container.querySelector("[data-workflow-receipt]")?.textContent).toContain(
    "256 agents · 0 agents failed",
  );
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

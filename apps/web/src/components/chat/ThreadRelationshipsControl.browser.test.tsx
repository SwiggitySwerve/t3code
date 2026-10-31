import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { readQaAtom, stubQaWorkflowStopPermission } from "../../../test/workflow-fixtures/atoms";
import {
  LINEAGE_FIRST_AGENT_TITLE,
  LINEAGE_PARENT,
  lineagePanelFixture,
} from "../../../test/workflow-fixtures/lineagePanel";
import { QA_ENVIRONMENT, QA_PROVIDERS } from "../../../test/workflow-fixtures/providers";
import { render } from "../../../test/render";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { workflowIdentityStatesFixture } from "../../../test/workflow-fixtures/workflowFixtures";
import { captureSurface } from "../../../test/workflow-fixtures/capture";
import { deriveWorkflowProgress } from "@t3tools/client-runtime/state/subagentRuntime";
import { expandWorkflowPhases } from "../../../test/workflow-fixtures/interactions";
import { WorkflowProgressOverview } from "./WorkflowProgressOverview";

const stop = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  fixture: null as unknown as { shells: unknown; projection: unknown },
}));

// The panel reads its thread through the app's entity hooks and atoms; each is answered from the
// workflow fixture, and any atom without a stub throws. The app modules are imported statically:
// a factory for the atom library must not import them.
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) =>
    readQaAtom(atom, selector)) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => stop) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null ? null : { projection: state.fixture.projection }) as never,
  useThreadRelationshipShells: (() => state.fixture.shells) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() => new Map([[QA_ENVIRONMENT, QA_PROVIDERS]])) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), async (original) => ({
  ...(await original()),
  useArchivedThreadSnapshots: (() => ({ snapshots: [] })) as never,
}));

async function showLineage(fixture = lineagePanelFixture()) {
  // A pointer left on the page by an earlier test would hover the row before the test does.
  await commands.resetPointer();
  state.fixture = fixture;
  stop.mockReset();
  stop.mockResolvedValue({ _tag: "Success" });
  const screen = await render(
    <ThreadRelationshipsPanel environmentId={QA_ENVIRONMENT} threadId={LINEAGE_PARENT} />,
    { router: "/" },
  );
  return { screen, title: fixture.workflowTitle };
}

describe("a workflow's row in the Lineage panel", () => {
  it("keeps graph outcome state and detail in the row and its hover card", async () => {
    using _permission = stubQaWorkflowStopPermission();
    const base = lineagePanelFixture();
    const fixture = workflowIdentityStatesFixture();
    const { screen } = await showLineage({
      ...base,
      projection: {
        ...base.projection,
        subagents: [
          {
            ...fixture.row,
            workflow: {
              ...fixture.row.workflow!,
              nodeOutcomes: {
                ...fixture.row.workflow!.nodeOutcomes,
                sol: { status: "failed", reason: "Graph outcome failed" },
              },
            },
          },
        ],
      },
    });
    await using _screen = screen;
    await userEvent.click(
      screen.getByRole("button", { name: "Expand Every agent state", exact: true }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Expand Phase 1 phase, failed", exact: true }),
    );
    const row = screen.getByRole("button", { name: "Open Sol running chat", exact: true });
    await expect.element(row.getByText("failed", { exact: true })).toBeVisible();
    await userEvent.hover(row);
    await expect.poll(() => document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
    const popup = page.elementLocator(document.querySelector('[data-slot="tooltip-popup"]')!);
    await expect.element(popup.getByText("failed", { exact: true })).toBeVisible();
    await expect.element(popup.getByText("Graph outcome failed", { exact: true })).toBeVisible();
    await expect.element(popup.getByText("running", { exact: true })).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "dot grid final: retains unstarted relationships, stopped=%s",
    async (stopped) => {
      using _permission = stubQaWorkflowStopPermission();
      const base = lineagePanelFixture();
      const fixture = workflowIdentityStatesFixture(stopped);
      state.fixture = { ...base, projection: { ...base.projection, subagents: [fixture.row] } };
      await captureSurface({
        surface: "workflow-dot-grid-relationships",
        state: stopped ? "stopped-not-started" : "not-started",
        selector: "[data-thread-relationships-panel]",
        frame: "[data-qa-relationships]",
        router: true,
        element: () => (
          <>
            <div
              className="max-w-80 rounded-xl border border-border bg-popover p-2 text-popover-foreground"
              data-qa-relationships
            >
              <ThreadRelationshipsPanel environmentId={QA_ENVIRONMENT} threadId={LINEAGE_PARENT} />
            </div>
            <WorkflowProgressOverview
              progress={deriveWorkflowProgress(fixture.group)}
              environmentId={QA_ENVIRONMENT}
              onOpenThread={() => {}}
            />
          </>
        ),
        settle: async (screen) => {
          if (stopped)
            await userEvent.click(screen.getByRole("button", { name: /Previous agents/ }));
          await userEvent.click(
            screen.getByRole("button", { name: "Expand Every agent state", exact: true }),
          );
          for (const button of screen.getByRole("button", { name: /^Expand .* phase,/ }).elements())
            await userEvent.click(button);
          await expandWorkflowPhases(screen);
          const progress = deriveWorkflowProgress(fixture.group);
          const stateColours: string[] = [];
          const cellColours = new Set<string>();
          for (const phase of progress.phases) {
            for (const task of phase.tasks) {
              const row = task.member
                ? screen.getByRole("button", { name: `Open ${task.label} chat`, exact: true })
                : screen.getByRole("listitem", {
                    name: `${task.label}, ${task.state}`,
                    exact: true,
                  });
              await expect.element(row.getByText(task.state, { exact: true })).toBeVisible();
              const icon = screen.container.querySelector(`[data-workflow-dot="${task.id}"]`)!;
              expect(icon.getAttribute("aria-description")?.split(",")[0]).toBe(task.state);
              const rowState = row.getByText(task.state, { exact: true }).element();
              expect(getComputedStyle(rowState).textTransform).toBe("none");
              stateColours.push(getComputedStyle(rowState).color);
              if (["done", "running", "failed"].includes(task.state))
                cellColours.add(
                  getComputedStyle(icon.querySelector("[data-workflow-identity]")!).color,
                );
            }
            expect(
              screen.container.querySelector(
                `[aria-label="${phase.counts.settled}/${phase.counts.total} settled"]`,
              ),
            ).not.toBeNull();
          }
          // Only a phase's bar carries state colour in the Lineage panel; the words stay neutral.
          expect(new Set(stateColours).size).toBe(1);
          expect(cellColours.size).toBeGreaterThan(1);
          expect(cellColours.has(stateColours[0]!)).toBe(false);
          const rows = screen.container.querySelectorAll("[data-workflow-unstarted-row]");
          expect(rows).toHaveLength(3);
          expect([...rows].map((row) => row.getAttribute("aria-label"))).toEqual([
            `Waiting for agent, ${stopped ? "stopped" : "queued"}`,
            "Skipped agent, skipped",
            `Agent not run, ${stopped ? "stopped" : "queued"}`,
          ]);
          expect(
            screen.container.querySelectorAll("[data-workflow-unstarted-row] button"),
          ).toHaveLength(0);
          rows[0]!.scrollIntoView({ block: "nearest" });
        },
      });
    },
  );
  it("counts a running workflow before and after its first agent gets a thread", async () => {
    using _permission = stubQaWorkflowStopPermission();
    const fixture = lineagePanelFixture();
    const { screen } = await showLineage({
      ...fixture,
      shells: [fixture.projection.thread],
      projection: {
        ...fixture.projection,
        subagents: fixture.projection.subagents.map((agent) => ({
          ...agent,
          workflow: { ...agent.workflow, agents: [] },
        })),
      },
    });
    await using _screen = screen;
    await expect
      .element(screen.getByRole("heading", { name: "Lineage · 1 running" }))
      .toBeVisible();

    state.fixture = fixture;
    await screen.rerender(
      <ThreadRelationshipsPanel environmentId={QA_ENVIRONMENT} threadId={LINEAGE_PARENT} />,
    );
    await expect
      .element(screen.getByRole("heading", { name: "Lineage · 1 running" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: `Expand ${fixture.workflowTitle}`, exact: true }))
      .toBeVisible();
  });

  it("is named for the workflow, never for its first agent's thread", async () => {
    using _permission = stubQaWorkflowStopPermission();
    const { screen, title } = await showLineage();
    await using _screen = screen;
    await expect
      .element(screen.getByRole("button", { name: `Expand ${title}`, exact: true }))
      .toBeVisible();
    expect(screen.container.textContent).toContain(title);
    expect(screen.container.textContent).not.toContain(LINEAGE_FIRST_AGENT_TITLE);
    // Its Stop button names the same workflow.
    expect(
      screen.container.querySelector(`button[aria-label="Stop workflow ${title}"]`),
    ).not.toBeNull();
  });

  it("offers Stop to a pointer that hovers the row, and Stop works", async () => {
    using _permission = stubQaWorkflowStopPermission();
    const { screen, title } = await showLineage();
    await using _screen = screen;
    const row = screen.getByRole("button", { name: new RegExp(`^Running ${title}`) });
    const button = screen.getByRole("button", { name: `Stop workflow ${title}`, exact: true });
    // The control reveals Stop through the wrapper around it.
    const wrapper = button.element().parentElement!;
    // At rest Stop is hidden and takes no pointer events, so the elapsed time stays readable.
    expect(getComputedStyle(wrapper).opacity).toBe("0");
    expect(getComputedStyle(wrapper).pointerEvents).toBe("none");
    await userEvent.hover(row);
    await expect.poll(() => getComputedStyle(wrapper).opacity).toBe("1");
    expect(getComputedStyle(wrapper).pointerEvents).toBe("auto");
    await userEvent.click(button);
    expect(stop).toHaveBeenCalledWith({
      environmentId: QA_ENVIRONMENT,
      input: { threadId: LINEAGE_PARENT, subagentId: expect.any(String) },
    });
  });

  it("offers Stop to the keyboard: Tab reaches it and Enter stops the workflow", async () => {
    using _permission = stubQaWorkflowStopPermission();
    const { screen, title } = await showLineage();
    await using _screen = screen;
    const button = screen.getByRole("button", { name: `Stop workflow ${title}`, exact: true });
    // The control reveals Stop through the wrapper around it.
    const wrapper = button.element().parentElement!;
    await userEvent.tab();
    await expect
      .element(screen.getByRole("button", { name: new RegExp(`^Running ${title}`) }))
      .toHaveFocus();
    await userEvent.tab();
    await expect.element(button).toHaveFocus();
    expect(getComputedStyle(wrapper).opacity).toBe("1");
    // React retains its permission atom across the Stop rerender, even after weak caches collect.
    await commands.collectGarbage();
    await userEvent.keyboard("{Enter}");
    expect(stop).toHaveBeenCalledTimes(1);
    await expect.element(button).toBeEnabled();
  });
});

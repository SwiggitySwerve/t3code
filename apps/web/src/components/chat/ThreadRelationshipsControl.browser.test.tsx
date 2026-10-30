import { describe, expect, it, vi } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser";

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

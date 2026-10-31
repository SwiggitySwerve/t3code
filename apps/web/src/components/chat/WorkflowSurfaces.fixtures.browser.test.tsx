import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { workflowClientSettings } from "../../../test/workflow-fixtures/settings";
import { readQaAtom } from "../../../test/workflow-fixtures/atoms";
import { captureSurface } from "../../../test/workflow-fixtures/capture";
import { render, type Screen } from "../../../test/render";
import {
  LineageRowSurface,
  WorkflowBlockSurface,
  WorkflowReviewSurface,
  SidebarStatusSurface,
  WorkflowCanvasSurface,
  WorkflowScriptProgressSurface,
  scrollWavesToNode,
} from "../../../test/workflow-fixtures/surfaces";
import {
  WORKFLOW_QA_SCRIPT_MARKER,
  WORKFLOW_QA_STATUSES,
  WORKFLOW_QA_STRESS,
  workflowCollapseFixture,
  workflowFixture,
  workflowLongElapsedFixture,
  workflowPhaseTitlesFixture,
  type WorkflowQaVariant,
} from "../../../test/workflow-fixtures/workflowFixtures";
import {
  WORKFLOW_QA_EXPECTED_STATES,
  WORKFLOW_QA_AGENT_COUNTS,
  WORKFLOW_QA_REVIEW_STATES,
  WORKFLOW_QA_RUNNING_WAVE,
  WORKFLOW_QA_STOP_VISIBLE,
} from "@t3tools/shared/testing/workflowQa";
import type ChatMarkdown from "../ChatMarkdown";
import { ThreadLineageWorkflowRow } from "./ThreadLineageWorkflowRow";
import { QA_PROVIDERS } from "../../../test/workflow-fixtures/providers";

// The surfaces read the provider catalog through the app's own atoms; any other atom throws.
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) =>
    readQaAtom(atom, selector)) as never,
}));
vi.mock(import("../ChatMarkdown"), async () => {
  const { memo } = await import("react");
  return {
    default: memo(({ text }: ComponentProps<typeof ChatMarkdown>) => <pre>{text}</pre>),
  };
});

const VARIANTS: ReadonlyArray<WorkflowQaVariant> = [...WORKFLOW_QA_STATUSES, ...WORKFLOW_QA_STRESS];
// The expected-state list in the shared module is the one definition of what each surface covers.
const statesOf = (surface: string) =>
  VARIANTS.filter((variant) => WORKFLOW_QA_EXPECTED_STATES[surface]?.includes(variant));

// The 150-node run has 15 waves of 10; wave 6 (index 5) is the one still running.
const RUNNING_WAVE_NODE = "n5-5";

it.each([false, true])("planned script phase transition, entered=%s", async (entered) => {
  await captureSurface({
    surface: "workflow-script-progress",
    state: entered ? "after-transition" : "before-transition",
    selector: "[data-workflow-opening]",
    frame: "[data-qa-column]",
    element: () => <WorkflowScriptProgressSurface entered={entered} />,
  });
});

it.each(["running", "completed", "failed", "stopped"] as const)(
  "callback phase lifecycle, state=%s",
  async (state) => {
    await captureSurface({
      surface: "workflow-script-progress",
      state: `callback-${state}`,
      selector: "[data-workflow-opening]",
      frame: "[data-qa-column]",
      element: () => <WorkflowScriptProgressSurface state={state} />,
    });
  },
);

describe.each(["graph", "script"] as const)("workflow block, %s", (kind) => {
  const surface = `workflow-block-${kind}`;
  it.each(statesOf(surface))("%s", async (variant) => {
    await captureSurface({
      surface,
      state: variant,
      selector: "[data-workflow-opening]",
      frame: "[data-qa-column]",
      element: () => <WorkflowBlockSurface kind={kind} variant={variant} />,
    });
  });
  it.each(WORKFLOW_QA_AGENT_COUNTS)("overview with %i agents", async (count) => {
    await captureSurface({
      surface,
      state: `agents-${count}`,
      selector: "[data-workflow-opening]",
      frame: "[data-qa-column]",
      element: () => <WorkflowBlockSurface kind={kind} agentCount={count} />,
    });
  });
});

it("workflow block, graph, 150 nodes scrolled to the running wave", async () => {
  await captureSurface({
    surface: "workflow-block-graph",
    state: WORKFLOW_QA_RUNNING_WAVE,
    selector: "[data-workflow-opening]",
    frame: "[data-qa-column]",
    element: () => <WorkflowBlockSurface kind="graph" variant="many-nodes" />,
    verboseGraph: true,
    settle: async (screen) => {
      await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
      await userEvent.click(screen.getByRole("button", { name: "More graph nodes", exact: true }));
      await scrollWavesToNode(screen.container, RUNNING_WAVE_NODE);
    },
  });
});

describe("workflow canvas", () => {
  it.each([256, 1024] as const)("scale direct canvas with %i agents", async (count) => {
    await captureSurface({
      surface: "workflow-canvas",
      state: `agents-${count}-running-wave`,
      selector: "[data-workflow-waves]",
      frame: "[data-qa-column]",
      element: () => <WorkflowCanvasSurface agentCount={count} />,
      settle: async (screen) => scrollWavesToNode(screen.container, `task-${count / 2}`),
    });
  });

  it.each(statesOf("workflow-canvas"))("%s", async (variant) => {
    await captureSurface({
      surface: "workflow-canvas",
      state: variant,
      selector: "[data-workflow-waves]",
      frame: "[data-qa-column]",
      element: () => <WorkflowCanvasSurface variant={variant} />,
    });
  });

  it("150 nodes scrolled to the running wave", async () => {
    await captureSurface({
      surface: "workflow-canvas",
      state: WORKFLOW_QA_RUNNING_WAVE,
      selector: "[data-workflow-waves]",
      frame: "[data-qa-column]",
      element: () => <WorkflowCanvasSurface variant="many-nodes" />,
      settle: async (screen) => scrollWavesToNode(screen.container, RUNNING_WAVE_NODE),
    });
  });
});

it.each([256, 1024] as const)("scale paged graph with %i agents", async (count) => {
  await captureSurface({
    surface: "workflow-block-graph",
    state: `agents-${count}-graph-page-2`,
    selector: "[data-workflow-opening]",
    frame: "[data-qa-column]",
    element: () => <WorkflowBlockSurface kind="graph" agentCount={count} />,
    verboseGraph: true,
    settle: async (screen) => {
      await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
      await userEvent.click(screen.getByRole("button", { name: "More graph nodes", exact: true }));
    },
  });
});

// The row starts folded, and so do its finished phases; the agents are what a person reads.
const expandLineage = async (screen: Screen) => {
  await userEvent.click(screen.getByRole("button", { name: /^Expand [^,]+$/ }));
  const folded = screen.getByRole("button", { name: /^Expand .+ phase,/ });
  for (let count = folded.elements().length; count > 0; count -= 1) {
    await userEvent.click(folded.first());
  }
  screen.getByRole("list", { name: "Related threads", exact: true }).element().scrollTop = 0;
};

describe.each(["graph", "script"] as const)("lineage row, %s", (kind) => {
  const surface = `lineage-row-${kind}`;
  it.each(statesOf(surface))("%s", async (variant) => {
    await captureSurface({
      surface,
      state: variant,
      selector: "[data-workflow-expanded]",
      frame: "[data-qa-panel]",
      widthIndependent: true,
      element: () => <LineageRowSurface kind={kind} variant={variant} />,
      settle: expandLineage,
    });
  });
});

// The details panel can be dragged narrow; these frames show the row at that width.
describe.each(["graph", "script"] as const)("lineage row, narrow panel, %s", (kind) => {
  const surface = `lineage-row-narrow-${kind}`;
  it.each(statesOf(surface))("%s", async (variant) => {
    await captureSurface({
      surface,
      state: variant,
      selector: "[data-workflow-expanded]",
      frame: "[data-qa-panel]",
      widthIndependent: true,
      element: () => <LineageRowSurface kind={kind} variant={variant} narrow />,
      settle: expandLineage,
    });
  });
});

it("lineage row, graph, running, Stop shown while the row is hovered", async () => {
  await captureSurface({
    surface: "lineage-row-graph",
    state: WORKFLOW_QA_STOP_VISIBLE,
    selector: "[data-workflow-expanded]",
    frame: "[data-qa-panel]",
    // Not width-checked: with the pointer held on the row, the first frame of a run differs from
    // the other widths in 26 edge pixels by one grey level, which no layout explains.
    element: () => <LineageRowSurface kind="graph" variant="running" />,
    // The Stop button exists only while the row is hovered or focused: that is this state.
    keepInteraction: true,
    settle: async (screen) => {
      await expandLineage(screen);
      await userEvent.hover(screen.getByRole("button", { name: /^Collapse [^,]+$/ }));
    },
  });
});

// Every phase row, with agent lists folded so each row's bar is in view. `shown` is how many bars
// must be drawn, or null when it depends on how much room each title leaves; `open` is a phase
// whose agent rows are shown.
it.each([
  ["graph-256", "graph", "collapse", false, 16, null],
  ["script-256", "script", "collapse", false, 16, null],
  ["graph-256-narrow", "graph", "collapse", true, 0, null],
  ["long-titles", "script", "long-labels", false, null, null],
  ["script-titles", "script", "titles", false, 4, null],
  ["agent-rows", "graph", "collapse", false, 16, "Phase 16"],
  ["long-elapsed", "graph", "elapsed", false, null, null],
] as const)("lineage phase bars, %s", async (state, kind, source, narrow, shown, open) => {
  await captureSurface({
    surface: "lineage-phase-bars",
    state,
    selector: "[data-workflow-expanded]",
    frame: "[data-qa-panel]",
    // Not width-checked: each folded row's chevron is CSS-rotated, and across runs a few of their
    // edge pixels differ by one grey level, which no layout explains.
    element: () =>
      source === "long-labels" ? (
        <LineageRowSurface kind={kind} variant="long-labels" />
      ) : (
        <LineageRowSurface
          kind={kind}
          fixture={
            source === "titles"
              ? workflowPhaseTitlesFixture()
              : source === "elapsed"
                ? workflowLongElapsedFixture()
                : workflowCollapseFixture(kind, 256)
          }
          narrow={narrow}
        />
      ),
    settle: async (screen) => {
      await userEvent.click(screen.getByRole("button", { name: /^Expand [^,]+$/ }));
      const folded = screen.getByRole("button", { name: /^Collapse .+ phase,/ });
      for (let opened = folded.elements().length; opened > 0; opened -= 1) {
        await userEvent.click(folded.first());
      }
      const list = screen.getByRole("list", { name: "Related threads", exact: true }).element();
      // The last phases hold the queued and failed rows; an opened phase is shown from its row.
      list.scrollTop = list.scrollHeight;
      if (open !== null) {
        const phase = screen
          .getByRole("button", { name: new RegExp(`^Expand ${open} phase,`) })
          .element();
        await userEvent.click(phase);
        list.scrollTop += phase.getBoundingClientRect().top - list.getBoundingClientRect().top;
      }
      const bars = [...list.querySelectorAll("[data-workflow-track]")].map((bar) =>
        bar.getBoundingClientRect(),
      );
      const drawn = bars.filter((bar) => bar.width > 0);
      // A bar is drawn at its full size or not at all, and every drawn bar starts at one edge.
      expect(bars.filter((bar) => bar.width === 0 && bar.height === 0)).toHaveLength(
        bars.length - drawn.length,
      );
      expect(drawn.map(({ width, height }) => [width, height])).toEqual(drawn.map(() => [56, 2]));
      expect(new Set(drawn.map((bar) => bar.left)).size).toBeLessThanOrEqual(1);
      if (shown !== null) expect(drawn).toHaveLength(shown);
    },
  });
});

// A collapsed row is what the Lineage list shows at rest: the run's status and title only.
describe.each(["graph", "script"] as const)("lineage row at rest, %s", (kind) => {
  const surface = `lineage-collapsed-${kind}`;
  it.each(statesOf(surface))("%s", async (variant) => {
    await captureSurface({
      surface,
      state: variant,
      selector: "li.group",
      frame: "[data-qa-panel]",
      widthIndependent: true,
      element: () => <LineageRowSurface kind={kind} variant={variant} />,
    });
  });
});

// The review card, in every state a person meets it in. The frames show what the shared
// presentation says for each state of the decision, not a hand-drawn copy.
describe("workflow review card", () => {
  it.each(WORKFLOW_QA_REVIEW_STATES)("%s", async (state) => {
    await captureSurface({
      surface: "workflow-review",
      state,
      selector: "[data-workflow-review]",
      frame: "[data-qa-column]",
      element: () => <WorkflowReviewSurface state={state} />,
    });
  });
});

describe("workflow fixture rows", () => {
  // Fixtures are projected rows run through the functions the timeline uses, so what a frame
  // says is what the app would say.
  it("says a graph's failure on its nodes and in its counts, not in a third sentence", () => {
    expect(workflowFixture("graph", "failed").progress).toBeNull();
    expect(workflowFixture("graph", "long-labels").progress).toBeNull();
  });

  it("reports what a finished run returned, and nothing for a graph that passed", () => {
    expect(workflowFixture("graph", "passed").progress).toBeNull();
    expect(workflowFixture("script", "passed").progress).toBe(
      '"Counted 412 source files and 57 documentation files."',
    );
    expect(workflowFixture("script", "failed").progress).toBe(
      "The workflow failed: Read docs: the command exited with code 1.",
    );
    expect(workflowFixture("script", "long-labels").progress).toMatch(
      /^The workflow failed: Read files: /,
    );
    for (const kind of ["graph", "script"] as const) {
      expect(workflowFixture(kind, "stopped").progress).toBe("Workflow stopped.");
    }
  });

  it("shows the live log line only for a running graph, and names each state", () => {
    expect(workflowFixture("graph", "running").progress).toBe("Started Count documentation files");
    expect(workflowFixture("graph", "queued").progress).toBeNull();
    expect(workflowFixture("graph", "failed").heading).toBe("Workflow failed");
    expect(workflowFixture("script", "stopped").heading).toBe("Workflow stopped");
    expect(workflowFixture("graph", "retrying").heading).toBe("Workflow running");
  });

  it("draws the failure once on the node and keeps the stored script out of the timeline", async () => {
    // The block reads no location, so it renders without the test router.
    using _settings = workflowClientSettings();
    await using screen = await render(<WorkflowBlockSurface kind="graph" variant="failed" />, {
      router: false,
    });
    expect(screen.container.textContent).not.toContain("Graph failed:");
    await expect.element(screen.getByText(/docs\/ was not found/).first()).toBeVisible();
    expect(screen.container.textContent).not.toContain(WORKFLOW_QA_SCRIPT_MARKER);
  });

  it("keeps a narrow Lineage panel's group counts whole", async () => {
    using _settings = workflowClientSettings();
    await using screen = await render(<LineageRowSurface kind="script" variant="failed" narrow />);
    await userEvent.click(screen.getByRole("button", { name: /^Expand [^,]+$/ }));
    const panel = screen.container.querySelector<HTMLElement>("[data-qa-panel]")!;
    const panelRight = panel.getBoundingClientRect().right;
    // Nothing inside the panel runs past its edge: the group counts are never clipped.
    for (const el of panel.querySelectorAll<HTMLElement>("li *")) {
      if (el.children.length === 0 && (el.textContent ?? "").trim() !== "") {
        expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(panelRight + 0.5);
      }
    }
    // The count itself is drawn, with its unit dropped first.
    expect(panel.textContent).toContain("2/?");
    expect(panel.textContent).toContain("2/? agents");
    // The run's time stays too: the group name gives way first.
    expect(panel.textContent).toContain("1m");
  });

  it("keeps a failed Lineage phase's elapsed time live while a sibling runs", async () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const { group } = workflowFixture("script", "running");
    const phase = group.phases[0]!;
    const member = phase.members[0]!;
    const mixed = {
      ...group,
      phases: [
        {
          ...phase,
          title: "Mixed",
          members: [
            {
              ...member,
              id: "failed",
              status: "failed" as const,
              startedAt: new Date(0).toISOString(),
              completedAt: new Date(10_000).toISOString(),
            },
            {
              ...member,
              id: "running",
              status: "running" as const,
              startedAt: new Date(0).toISOString(),
              completedAt: null,
            },
          ],
        },
      ],
      unphasedMembers: [],
    };
    const surface = () => (
      <ThreadLineageWorkflowRow
        group={mixed}
        header={<span>Mixed workflow</span>}
        provider={QA_PROVIDERS[0]}
        providers={QA_PROVIDERS}
        onOpenThread={() => {}}
        isThreadAvailable={() => true}
        stopping={false}
        stopDisabled={false}
      />
    );
    using _settings = workflowClientSettings();
    await using screen = await render(surface());
    await userEvent.click(screen.getByRole("button", { name: /^Expand [^,]+$/ }));
    const header = screen.getByRole("button", { name: "Expand Mixed phase, failed" });
    expect(header.element().textContent).toContain("1m 40s");
    now.mockReturnValue(200_000);
    await screen.rerender(surface());
    expect(header.element().textContent).toContain("3m 20s");
  });

  it("gives queued, waiting and skipped nodes a glyph each, and Waiting an hourglass in the sidebar", async () => {
    await using canvas = await render(<WorkflowCanvasSurface variant="queued" />, {
      // Canvas glyphs are rendered from fixture props without navigation.
      router: false,
    });
    expect(canvas.container.querySelector("svg.lucide-clock")).not.toBeNull();
    expect(canvas.container.querySelector("svg.lucide-hourglass")).not.toBeNull();
    await using failed = await render(<WorkflowCanvasSurface variant="failed" />, {
      // Skipped-node glyphs are rendered from fixture props without navigation.
      router: false,
    });
    expect(failed.container.querySelector("svg.lucide-minus")).not.toBeNull();
    await using waiting = await render(<SidebarStatusSurface state="waiting-idle" />, {
      // The sidebar status glyph does not read router state.
      router: false,
    });
    expect(waiting.container.querySelector("svg.lucide-hourglass")).not.toBeNull();
    expect(waiting.container.querySelector("svg.lucide-circle-dot-dashed")).toBeNull();
  });

  it("says what a sidebar badge needs, and draws a queued agent's dot grey", async () => {
    const labels = {
      approval: "Needs approval",
      input: "Needs input",
      limited: "Usage limit",
      "turn-ended-workflow-running": "Working",
    } as const;
    for (const [state, label] of Object.entries(labels)) {
      using _settings = workflowClientSettings();
      await using screen = await render(
        <SidebarStatusSurface state={state as keyof typeof labels} />,
        {
          // Sidebar badges depend only on the supplied status.
          router: false,
        },
      );
      expect(screen.container.textContent).toContain(label);
    }
    await using queued = await render(<WorkflowBlockSurface kind="script" variant="queued" />, {
      // Queued-agent styling is supplied by the fixture without navigation.
      router: false,
    });
    expect(queued.container.querySelector(".bg-info")).toBeNull();
  });

  it("keeps the Approve button legible while approving", async () => {
    await using pending = await render(<WorkflowReviewSurface state="pending" />, {
      // Approval styling depends on fixture state, not the route.
      router: false,
    });
    const idle = getComputedStyle(
      pending.getByRole("button", { name: /^Approve/ }).element(),
    ).backgroundColor;
    await using approving = await render(<WorkflowReviewSurface state="approving" />, {
      // Approval styling depends on fixture state, not the route.
      router: false,
    });
    const button = approving.getByRole("button", { name: /^Approving/ }).element();
    // Busy it is outlined, not a filled primary button faded to white on pale blue.
    expect(getComputedStyle(button).backgroundColor).not.toBe(idle);
  });

  it("names the run's state in the Lineage header, in words", async () => {
    using _settings = workflowClientSettings();
    await using screen = await render(<LineageRowSurface kind="script" variant="failed" />);
    const header = screen.getByRole("button", { name: /State audit/ }).first();
    // The word is drawn, not only read by a screen reader: a screen-reader-only span is 1px wide.
    const word = header.getByText("Failed", { exact: true });
    await expect.element(word).toBeVisible();
    expect(word.element().getBoundingClientRect().width).toBeGreaterThan(12);
  });
});

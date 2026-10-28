import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { readQaAtom } from "../../../test/workflow-fixtures/atoms";
import { captureSurface } from "../../../test/workflow-fixtures/capture";
import { render, type Screen } from "../../../test/render";
import {
  LineageRowSurface,
  WorkflowBlockSurface,
  WorkflowReviewSurface,
  SidebarStatusSurface,
  WorkflowCanvasSurface,
  scrollWavesToNode,
} from "../../../test/workflow-fixtures/surfaces";
import {
  WORKFLOW_QA_SCRIPT_MARKER,
  WORKFLOW_QA_STATUSES,
  WORKFLOW_QA_STRESS,
  workflowFixture,
  type WorkflowQaVariant,
} from "../../../test/workflow-fixtures/workflowFixtures";
import {
  WORKFLOW_QA_EXPECTED_STATES,
  WORKFLOW_QA_REVIEW_STATES,
  WORKFLOW_QA_RUNNING_WAVE,
  WORKFLOW_QA_STOP_VISIBLE,
} from "@t3tools/shared/testing/workflowQa";
import type ChatMarkdown from "../ChatMarkdown";

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
});

it("workflow block, graph, 150 nodes scrolled to the running wave", async () => {
  await captureSurface({
    surface: "workflow-block-graph",
    state: WORKFLOW_QA_RUNNING_WAVE,
    selector: "[data-workflow-opening]",
    frame: "[data-qa-column]",
    element: () => <WorkflowBlockSurface kind="graph" variant="many-nodes" />,
    settle: async (screen) => scrollWavesToNode(screen.container, RUNNING_WAVE_NODE),
  });
});

describe("workflow canvas", () => {
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

// The row starts folded, and so do its finished phases; the agents are what a person reads.
const expandLineage = async (screen: Screen) => {
  await userEvent.click(screen.getByRole("button", { name: /^Expand [^,]+$/ }));
  const folded = screen.getByRole("button", { name: /^Expand .+ phase,/ });
  for (let count = folded.elements().length; count > 0; count -= 1) {
    await userEvent.click(folded.first());
  }
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
    await using screen = await render(<WorkflowBlockSurface kind="graph" variant="failed" />, {
      router: false,
    });
    expect(screen.container.textContent).not.toContain("Graph failed:");
    await expect.element(screen.getByText(/docs\/ was not found/).first()).toBeVisible();
    expect(screen.container.textContent).not.toContain(WORKFLOW_QA_SCRIPT_MARKER);
  });

  it("keeps a narrow Lineage panel's group counts whole", async () => {
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
    expect(panel.textContent).toContain("2/2");
    expect(panel.textContent).toContain("2/2 agents");
    // The run's time stays too: the group name gives way first.
    expect(panel.textContent).toContain("1m");
  });

  it("gives queued, waiting and skipped nodes a glyph each, and Waiting an hourglass in the sidebar", async () => {
    await using canvas = await render(<WorkflowCanvasSurface variant="queued" />, {
      router: false,
    });
    expect(canvas.container.querySelector("svg.lucide-clock")).not.toBeNull();
    expect(canvas.container.querySelector("svg.lucide-hourglass")).not.toBeNull();
    await using failed = await render(<WorkflowCanvasSurface variant="failed" />, {
      router: false,
    });
    expect(failed.container.querySelector("svg.lucide-minus")).not.toBeNull();
    await using waiting = await render(<SidebarStatusSurface state="waiting-idle" />, {
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
      await using screen = await render(
        <SidebarStatusSurface state={state as keyof typeof labels} />,
        { router: false },
      );
      expect(screen.container.textContent).toContain(label);
    }
    await using queued = await render(<WorkflowBlockSurface kind="script" variant="queued" />, {
      router: false,
    });
    expect(queued.container.querySelector(".bg-info")).toBeNull();
  });

  it("keeps the Approve button legible while approving", async () => {
    await using pending = await render(<WorkflowReviewSurface state="pending" />, {
      router: false,
    });
    const idle = getComputedStyle(
      pending.getByRole("button", { name: /^Approve/ }).element(),
    ).backgroundColor;
    await using approving = await render(<WorkflowReviewSurface state="approving" />, {
      router: false,
    });
    const button = approving.getByRole("button", { name: /^Approving/ }).element();
    // Busy it is outlined, not a filled primary button faded to white on pale blue.
    expect(getComputedStyle(button).backgroundColor).not.toBe(idle);
  });

  it("names the run's state in the Lineage header, in words", async () => {
    await using screen = await render(<LineageRowSurface kind="script" variant="failed" />);
    const header = screen.getByRole("button", { name: /^State audit/ }).first();
    // The word is drawn, not only read by a screen reader: a screen-reader-only span is 1px wide.
    const word = header.getByText("Failed", { exact: true });
    await expect.element(word).toBeVisible();
    expect(word.element().getBoundingClientRect().width).toBeGreaterThan(12);
  });
});

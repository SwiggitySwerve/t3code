import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "../../index.css";
import type { Screen } from "../../../test/render";
import { captureSurface } from "../../../test/workflow-fixtures/capture";
import { readQaAtom } from "../../../test/workflow-fixtures/atoms";
import { WorkflowBlockSurface } from "../../../test/workflow-fixtures/surfaces";
import {
  workflowCollapseFixture,
  workflowPhaseSizesFixture,
  type WorkflowQaFixture,
  type WorkflowQaPhaseSpec,
} from "../../../test/workflow-fixtures/workflowFixtures";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) =>
    readQaAtom(atom, selector)) as never,
}));

const MOCKUP_PHASES: ReadonlyArray<WorkflowQaPhaseSpec> = [
  { title: "Survey", total: 16, done: 16 },
  { title: "Audit", total: 128, done: 128 },
  { title: "Review the findings", total: 64, done: 38, failed: 1, running: 12, queued: 13 },
  { title: "Fix", total: 32 },
  { title: "Verify", total: 16 },
];

function bar(screen: Screen) {
  return screen.container.querySelector<HTMLElement>("[data-workflow-bar]")!;
}

function segments(screen: Screen) {
  return [...screen.container.querySelectorAll<HTMLElement>("[data-workflow-segment]")];
}

function text(screen: Screen, selector: string) {
  return screen.container.querySelector(selector)?.textContent ?? "";
}

async function capture(
  state: string,
  fixture: WorkflowQaFixture,
  settle: (screen: Screen) => Promise<void>,
) {
  await captureSurface({
    surface: "workflow-progress-bar",
    state,
    selector: "[data-workflow-opening]",
    frame: "[data-qa-column]",
    element: () => <WorkflowBlockSurface kind="script" fixture={fixture} />,
    settle,
  });
}

it("progress bar final: running with declared totals", async () => {
  await capture(
    "declared",
    workflowPhaseSizesFixture("Audit the package exports", MOCKUP_PHASES),
    async (screen) => {
      expect(text(screen, "[data-workflow-headline]")).toBe(
        "182 of 256 agents71% · 1 failed · Review the findings running",
      );
      expect(bar(screen).dataset.workflowBar).toBe("declared");
      expect(bar(screen).getBoundingClientRect().height).toBe(8);
      expect(segments(screen).map((segment) => segment.style.flexGrow)).toEqual([
        "16",
        "128",
        "64",
        "32",
        "16",
      ]);
      await expect
        .element(screen.getByRole("progressbar", { name: "Workflow tasks settled" }))
        .toHaveAttribute(
          "aria-valuetext",
          "183/256 settled; 182 done · 1 failed · 12 running · 13 queued",
        );
      // Done and queued runs fold; the phase with a failure keeps its agents in view.
      await expect
        .element(screen.getByRole("button", { name: /^Survey–Audit · 144 done/ }))
        .toHaveAttribute("aria-expanded", "false");
      await expect
        .element(screen.getByRole("button", { name: /^Fix–Verify · 48 queued/ }))
        .toHaveAttribute("aria-expanded", "false");
      expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(64);
      expect(
        [...screen.container.querySelectorAll("[data-workflow-marker]")].map(
          (marker) => (marker as HTMLElement).dataset.workflowMarker,
        ),
      ).toEqual(["done", "failed", "queued"]);
    },
  );
});

it("progress bar final: unknown totals", async () => {
  await capture(
    "unknown-totals",
    workflowPhaseSizesFixture("Migrate settings to the new schema", [
      { title: "Find usages", total: null, done: 19 },
      { title: "Rewrite call sites", total: null, done: 4, running: 4 },
    ]),
    async (screen) => {
      expect(text(screen, "[data-workflow-headline]")).toBe(
        "23 agents doneRewrite call sites running · 27 discovered · total unknown",
      );
      expect(text(screen, "[data-workflow-headline]")).not.toContain("%");
      expect(bar(screen).dataset.workflowBar).toBe("unknown");
      expect(screen.container.querySelector("[data-workflow-bar-cap]")).not.toBeNull();
      // Undeclared phases share the width equally, whatever they have discovered.
      expect(segments(screen).map((segment) => segment.style.flexGrow)).toEqual(["1", "1"]);
      const widths = segments(screen).map((segment) => segment.getBoundingClientRect().width);
      expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(1);
    },
  );
});

it("progress bar final: twelve phases merge done and queued runs", async () => {
  await capture(
    "twelve-phases",
    workflowPhaseSizesFixture(
      "Audit twelve packages",
      Array.from({ length: 12 }, (_, index) => ({
        title: `Phase ${index + 1}`,
        total: 8,
        ...(index < 5 ? { done: 8 } : index < 7 ? { done: 3, running: 5 } : {}),
      })),
    ),
    async (screen) => {
      expect(segments(screen).map((segment) => segment.dataset.workflowSegmentSummary)).toEqual([
        "Phases 1–5: 40 done",
        "Phase 6: 3 done · 5 running",
        "Phase 7: 3 done · 5 running",
        "Phases 8–12: not started",
      ]);
      expect(text(screen, "[data-workflow-headline]")).toContain("2 phases running");
    },
  );
});

it("progress bar final: a 2/200/2 skew keeps every phase visible", async () => {
  await capture(
    "skew",
    workflowPhaseSizesFixture("Skewed audit", [
      { title: "Plan", total: 2, done: 2 },
      { title: "Audit every file", total: 200, done: 80, running: 40, queued: 80 },
      { title: "Report", total: 2 },
    ]),
    async (screen) => {
      const [plan, audit, report] = segments(screen).map(
        (segment) => segment.getBoundingClientRect().width,
      );
      expect(plan).toBeGreaterThanOrEqual(6);
      expect(report).toBeGreaterThanOrEqual(6);
      expect(audit).toBeGreaterThan(bar(screen).getBoundingClientRect().width * 0.9);
    },
  );
});

it("progress bar final: failed", async () => {
  await capture(
    "failed",
    workflowPhaseSizesFixture(
      "Audit the package exports",
      [
        { title: "Survey", total: 16, done: 16 },
        // The failure ends the run before the phase's last 11 agents start.
        { title: "Review the findings", total: 32, done: 20, failed: 1 },
        { title: "Fix", total: 16 },
      ],
      "failed",
    ),
    async (screen) => {
      expect(text(screen, "[data-workflow-receipt]")).toContain("1 agent failed");
      expect(screen.container.querySelector("[data-workflow-headline]")).toBeNull();
      // Work the failure stopped is skipped, not queued.
      expect(screen.container.querySelectorAll('[data-workflow-unreached="skipped"]')).toHaveLength(
        2,
      );
      await expect
        .element(screen.getByRole("button", { name: "Hide phases", exact: true }))
        .toHaveAttribute("aria-expanded", "true");
      expect(
        [...screen.container.querySelectorAll("[data-workflow-marker]")].map(
          (marker) => (marker as HTMLElement).dataset.workflowMarker,
        ),
      ).toEqual(["done", "failed", "skipped"]);
      expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(21);
    },
  );
});

it("progress bar final: stopped", async () => {
  await capture(
    "stopped",
    workflowPhaseSizesFixture(
      "Audit the package exports",
      [
        { title: "Survey", total: 16, done: 16 },
        // Stop lands before the phase's last 12 agents start.
        { title: "Review the findings", total: 32, done: 20 },
        { title: "Fix", total: 16 },
      ],
      "cancelled",
    ),
    async (screen) => {
      await expect.element(screen.getByText("Workflow stopped", { exact: true })).toBeVisible();
      expect(screen.container.querySelectorAll('[data-workflow-unreached="stopped"]')).toHaveLength(
        2,
      );
      expect(
        [...screen.container.querySelectorAll("[data-workflow-marker]")].map(
          (marker) => (marker as HTMLElement).dataset.workflowMarker,
        ),
      ).toEqual(["done", "stopped", "stopped"]);
      await expect.element(screen.getByRole("button", { name: /^Fix · 16 not run/ })).toBeVisible();
    },
  );
});

it("progress bar final: finished", async () => {
  await capture("finished", workflowCollapseFixture("graph", 256, "completed"), async (screen) => {
    expect(text(screen, "[data-workflow-receipt]")).toContain("256 agents");
    expect(bar(screen).getBoundingClientRect().height).toBe(4);
    expect(screen.container.querySelector("[data-workflow-unreached]")).toBeNull();
    expect(screen.container.querySelectorAll("[data-workflow-dot]")).toHaveLength(0);
    const show = screen.getByRole("button", { name: "Show phases", exact: true });
    await userEvent.click(show);
    expect(screen.container.querySelectorAll("[data-workflow-marker]").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Hide phases", exact: true }));
  });
});

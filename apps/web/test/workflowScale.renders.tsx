import {
  deriveWorkflowProgress,
  resolveAppWorkflowView,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { Profiler, version as reactVersion, type ProfilerOnRenderCallback } from "react";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import "../src/index.css";
import { render } from "./render";
import { startCounting, stopCounting } from "./renderCounter";
import { workflowClientSettings } from "./workflow-fixtures/settings";
import { readQaAtom } from "./workflow-fixtures/atoms";
import {
  WorkflowBlockSurface,
  WorkflowCanvasSurface,
  scrollWavesToNode,
} from "./workflow-fixtures/surfaces";
import { workflowScaleFixture, type WorkflowQaFixture } from "./workflow-fixtures/workflowFixtures";
import { workflowCollapseFixture } from "./workflow-fixtures/workflowFixtures";
import { expandWorkflowPhases } from "./workflow-fixtures/interactions";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) =>
    readQaAtom(atom, selector)) as never,
}));

function inspectDom(container: HTMLElement) {
  const count = (selector: string) => container.querySelectorAll(selector).length;
  return {
    elements: count("*"),
    phases: count("[data-workflow-phase]"),
    taskRows: count("[data-workflow-task]"),
    dots: count("[data-workflow-dot]"),
    dotTabStops: count('[data-workflow-dot][tabindex="0"]'),
    nodes: count("[data-workflow-node]"),
    fullCards: count("[data-workflow-node]:not([data-workflow-node-placeholder])"),
    placeholders: count("[data-workflow-node-placeholder]"),
    edges: count("[data-workflow-waves] > div > svg > path"),
    columnWidth: container.querySelector("[data-qa-column]")?.getBoundingClientRect().width,
    blockHeight: container.querySelector("[data-workflow-opening]")?.getBoundingClientRect().height,
  };
}

// Observe committed DOM state; no frame waits or elapsed-time pass/fail limits.
function observeCompletion(
  container: HTMLElement,
  selector: string,
  attribute: string,
  value: string,
) {
  let observer: MutationObserver;
  const done = new Promise<void>((resolve) => {
    const check = () => {
      if (!container.querySelector(selector)?.getAttribute(attribute)?.startsWith(value)) return;
      observer.disconnect();
      resolve();
    };
    observer = new MutationObserver(check);
    observer.observe(container, { subtree: true, attributes: true, childList: true });
    check();
  });
  return { done, [Symbol.dispose]: () => observer.disconnect() };
}

const CASES = ([256, 1024] as const).flatMap((count) =>
  (["graph-overview", "script-overview", "paged-graph", "direct-canvas"] as const).map(
    (surface) => ({
      count,
      surface,
    }),
  ),
);

const COLLAPSE_CASES = (["graph", "script"] as const).flatMap((kind) =>
  ([4, 40, 256, 1024] as const).flatMap((count) =>
    (["running", "completed"] as const).flatMap((status) =>
      [false, true].map((expanded) => ({ kind, count, status, expanded })),
    ),
  ),
);

it.runIf(import.meta.env.VITE_T3_WORKFLOW_SCALE === "1").each(COLLAPSE_CASES)(
  "workflow collapse footprint: $kind / $count / $status / expanded=$expanded",
  async ({ kind, count, status, expanded }) => {
    using _settings = workflowClientSettings();
    const previous = { width: innerWidth, height: innerHeight };
    await page.viewport(736, 900);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
    };
    const fixture = workflowCollapseFixture(kind, count, status);
    const expected = new Map(
      deriveWorkflowProgress(fixture.group).phases.flatMap((phase) =>
        phase.tasks.map((task) => [task.id, task.state] as const),
      ),
    );
    const samples = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const start = performance.now();
      await using screen = await render(<WorkflowBlockSurface kind={kind} fixture={fixture} />, {
        // The production surface receives its routing inputs through props.
        router: false,
      });
      const mountMs = performance.now() - start;
      if (expanded) await expandWorkflowPhases(screen);
      const readyMs = performance.now() - start;
      const cells = screen.container.querySelectorAll<HTMLButtonElement>("[data-workflow-dot]");
      if (expanded) expect(cells).toHaveLength(count);
      for (const cell of cells) {
        expect(expected.has(cell.dataset.workflowDot!)).toBe(true);
        expect(cell.getAttribute("aria-description")).toMatch(
          new RegExp(`^${expected.get(cell.dataset.workflowDot!)}(?:,|$)`),
        );
      }
      samples.push({ sample, mountMs, readyMs, dom: inspectDom(screen.container) });
    }
    await commands.writeRenderReport(
      `workflow-collapse-${kind}-${count}-${status}-${expanded ? "expanded" : "default"}`,
      JSON.stringify(
        {
          kind,
          count,
          status,
          expanded,
          samples,
          methodology:
            "First sample after imports; warm median of samples 1–4. mountMs is render/act through committed DOM. readyMs also includes user-event disclosures for all-expanded cases. No paint, cold-cache, CPU or memory claim. Same 736px viewport; no samples discarded.",
        },
        null,
        2,
      ),
    );
  },
);

// Opt in separately so scripts/render-metrics.ts keeps its existing report schema.
it.runIf(import.meta.env.VITE_T3_WORKFLOW_SCALE === "1").each(CASES)(
  "workflow scale measurement: $surface / $count",
  async ({ count, surface }) => {
    using _settings = workflowClientSettings(surface === "paged-graph");
    const originalViewport = { width: innerWidth, height: innerHeight };
    await page.viewport(1024, 900);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(originalViewport.width, originalViewport.height),
    };
    const kind = surface === "script-overview" ? "script" : "graph";
    const before = workflowScaleFixture(kind, count);
    const after = workflowScaleFixture(kind, count, true);
    const isCanvas = surface === "direct-canvas";
    const isOverview = surface.endsWith("overview");
    const commits: Array<{ phase: string; actualDurationMs: number; baseDurationMs: number }> = [];
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration, baseDuration) => {
      commits.push({ phase, actualDurationMs: actualDuration, baseDurationMs: baseDuration });
    };
    const view = (fixture: WorkflowQaFixture) => (
      <Profiler id={surface} onRender={onRender}>
        {isCanvas ? (
          <WorkflowCanvasSurface fixture={fixture} />
        ) : (
          <WorkflowBlockSurface kind={kind} fixture={fixture} />
        )}
      </Profiler>
    );
    async function measured<T>(operation: string, action: () => Promise<T>) {
      commits.length = 0;
      startCounting();
      const start = performance.now();
      try {
        const value = await action();
        const wallMs = performance.now() - start;
        return {
          value,
          metrics: {
            operation,
            wallMs,
            reactActualDurationMs: commits.reduce(
              (sum, commit) => sum + commit.actualDurationMs,
              0,
            ),
            commits: [...commits],
            renders: stopCounting(),
          },
        };
      } finally {
        stopCounting();
      }
    }
    const samples = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const aggregationStart = performance.now();
      const opening = resolveAppWorkflowView(before.row)!;
      const resolvedAt = performance.now();
      const progress = deriveWorkflowProgress(opening.group!);
      const aggregatedAt = performance.now();
      expect(progress.counts.observed).toBe(count);
      const operations = [];
      const mounted = await measured("mount", () =>
        render(view(before), {
          // These production surfaces receive all routing inputs as props.
          router: false,
        }),
      );
      await using screen = mounted.value;
      operations.push({ ...mounted.metrics, dom: inspectDom(screen.container) });
      if (surface === "paged-graph") {
        const disclosed = await measured("disclose-graph", () =>
          userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true })),
        );
        operations.push({ ...disclosed.metrics, dom: inspectDom(screen.container) });
        const paged = await measured("next-graph-page", () =>
          userEvent.click(screen.getByRole("button", { name: "More graph nodes", exact: true })),
        );
        operations.push({ ...paged.metrics, dom: inspectDom(screen.container) });
        // Navigate to the selected running agent; this setup is outside update timing.
        for (let graphPage = 1; graphPage < Math.floor(count / 2 / 40); graphPage += 1) {
          await userEvent.click(
            screen.getByRole("button", { name: "More graph nodes", exact: true }),
          );
        }
      }
      if (!isOverview) {
        const scrolled = await measured("scroll-to-selected-agent", () =>
          scrollWavesToNode(screen.container, `task-${count / 2}`),
        );
        operations.push({ ...scrolled.metrics, dom: inspectDom(screen.container) });
      }
      const selector = isOverview
        ? `[data-workflow-dot][aria-label="Open Agent ${count / 2 + 1}"]`
        : `[data-workflow-node="task-${count / 2}"] [data-node-state]`;
      const attribute = isOverview ? "aria-description" : "data-node-state";
      using completion = observeCompletion(
        screen.container,
        selector,
        attribute,
        isOverview ? "done" : "passed",
      );
      const updated = await measured("selected-agent-update", async () => {
        const submitStart = performance.now();
        await screen.rerender(view(after));
        const propSubmissionMs = performance.now() - submitStart;
        await completion.done;
        return { propSubmissionMs };
      });
      operations.push({
        ...updated.metrics,
        ...updated.value,
        configuredCoalescingDelayMs: isCanvas ? 0 : 1000,
        dom: inspectDom(screen.container),
      });
      samples.push({
        sample,
        mountKind:
          sample === 0 ? "first mount of this case after imports" : "subsequent warm mount",
        resolveAppWorkflowViewMs: resolvedAt - aggregationStart,
        deriveWorkflowProgressMs: aggregatedAt - resolvedAt,
        operations,
      });
    }
    await commands.writeRenderReport(
      `workflow-scale-${surface}-${count}`,
      JSON.stringify(
        {
          schemaVersion: 1,
          surface,
          count,
          syntheticBeyondRuntimeLimit: count === 1024,
          browser: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
          build: {
            mode: import.meta.env.MODE,
            dev: import.meta.env.DEV,
            reactVersion,
            reactCompiler: true,
          },
          methodology: {
            samples: 5,
            firstMountSamples: 1,
            warmMountSamples: 4,
            startup:
              "Browser/profile startup, Vite imports/transforms, and fixture construction excluded; caches not cleared. First mount is not cold-cache evidence.",
            wall: "performance.now around render/act or userEvent through committed DOM state; includes harness and synchronous effects, not a paint guarantee. Scroll includes existing vi.waitFor polling overhead.",
            react:
              "Profiler actualDuration sums render work, not commit/layout/paint. React development, Compiler, Profiler and DevTools renderCounter overhead enabled; no production-build claim.",
            aggregation:
              "Fresh resolveAppWorkflowView(row) then deriveWorkflowProgress(group), separately timed outside React. Mount/update also include the component's own derive call; do not add these costs together.",
            update: isCanvas
              ? "Direct prop update: no coalescing in standalone canvas."
              : "Production WorkflowOpeningBlock real 1,000ms snapshot coalescing included in wall time; not subtracted or treated as rendering cost.",
            captures: false,
            unmeasured: [
              "CPU time",
              "peak memory",
              "tokens",
              "real providers",
              "production build",
              "paint latency",
            ],
          },
          samples,
        },
        null,
        2,
      ),
    );
  },
);

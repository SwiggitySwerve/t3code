import { createMemoryHistory } from "@tanstack/react-router";
import {
  NodeId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, server, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  assistantItem,
  installFakeEnvironment,
  threadWithHistory,
  workflowReviewItem,
  type FakeDriver,
  type FakeThread,
  userItem,
} from "./fakeEnvironment";
import { act, fakeTimers, render } from "./render";
import { commitsSoFar } from "./renderCounter";
import { QA_PROVIDERS } from "./workflow-fixtures/providers";
import { WORKFLOW_QA_NOW, workflowCollapseFixture } from "./workflow-fixtures/workflowFixtures";
import { workflowReviewFixtureRecord } from "@t3tools/shared/testing/workflowReviewFixture";

vi.mock("../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("./fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

// The fixture deliberately leaves unrelated RPCs pending.
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

function workflowThread(name: string, count: 4 | 256, status: "running" | "completed" | "failed") {
  const history = threadWithHistory(name, 1);
  const run = history.runs[0]!;
  const seed = workflowCollapseFixture("graph", count, status).row;
  const row: OrchestrationV2Subagent = {
    ...seed,
    id: NodeId.make(`${name}-workflow`),
    threadId: history.id,
    runId: run.id,
    createdBy: "agent",
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    workflow: {
      ...seed.workflow!,
      agents: seed.workflow!.agents.map((agent) => ({
        ...agent,
        ...(agent.childThreadId
          ? { childThreadId: ThreadId.make(`${name}-${agent.childThreadId}`) }
          : {}),
      })),
    },
  };
  const item: OrchestrationV2TurnItem = {
    ...assistantItem(history.id, run.id, `${name}-workflow-item`, 2, ""),
    id: TurnItemId.make(`${name}-workflow-item`),
    type: "subagent",
    ordinal: 2,
    status,
    title: row.workflow?.name ?? row.title,
    subagentId: row.id,
    origin: row.origin,
    driver: row.driver,
    providerInstanceId: row.providerInstanceId,
    childThreadId: null,
    prompt: row.prompt,
    result: row.result,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
  const parent: FakeThread = {
    ...history,
    title:
      count === 4
        ? "Small package audit"
        : status === "running"
          ? "Package audit in progress"
          : status === "failed"
            ? "Audit needs attention"
            : "Audit complete",
    items: [
      userItem(
        history.id,
        run.id,
        `${name}-user`,
        0,
        "Audit the package exports and report any problems.",
      ),
      assistantItem(
        history.id,
        run.id,
        `${name}-assistant`,
        1,
        "I’ll check the packages in phases and keep the results here.",
      ),
      item,
    ],
    subagents: [row],
    shell: { status: status === "running" ? "running" : "completed" },
  };
  const children: FakeThread[] = row.workflow!.agents.flatMap((agent) =>
    agent.childThreadId
      ? [
          {
            ...threadWithHistory(agent.childThreadId, 0),
            title: agent.label,
            shell: {
              status: agent.state === "running" ? "running" : "completed",
              createdBy: "agent",
              lineage: {
                rootThreadId: parent.id,
                parentThreadId: parent.id,
                relationshipToParent: "subagent",
              },
            },
          },
        ]
      : [],
  );
  return [parent, ...children];
}

/** A plan the coordinator reviewed, waiting for the person to approve it before any agent starts. */
function reviewThread(): FakeThread {
  const history = threadWithHistory("workflow-review", 1);
  const run = history.runs[0]!;
  return {
    ...history,
    title: "Fix the sync bug",
    items: [
      userItem(history.id, run.id, "workflow-review-user", 0, "Fix the sync bug with a workflow."),
      assistantItem(
        history.id,
        run.id,
        "workflow-review-assistant",
        1,
        "I planned four tasks in three steps. Approve the plan to start them.",
      ),
      workflowReviewItem(
        history.id,
        run.id,
        "workflow-review-item",
        2,
        workflowReviewFixtureRecord(),
      ),
    ],
  };
}

const preset = (id: string, name: string, model: string, effort?: string) => ({
  id,
  name,
  target: {
    providerInstanceId: ProviderInstanceId.make("cliproxy"),
    model,
    options: effort ? [{ id: "reasoningEffort", value: effort }] : [],
  },
});

const threads = [
  reviewThread(),
  ...workflowThread("workflow-small", 4, "running"),
  ...workflowThread("workflow-live", 256, "running"),
  ...workflowThread("workflow-finished", 256, "completed"),
  ...workflowThread("workflow-failed", 256, "failed"),
];
installFakeEnvironment(threads, QA_PROVIDERS, {
  workflows: true,
  workflowPresets: {
    presets: [
      preset("planner", "Planner", "claude-opus-5-5"),
      preset("worker", "Worker", "claude-haiku-5-5", "high"),
      preset("scout", "Scout (cheaper)", "claude-haiku-5-5", "medium"),
      preset("verifier", "Verifier", "claude-opus-5-5"),
    ],
    defaultPresetId: "worker",
  },
});

const views = [
  { name: "01-small-running", thread: "workflow-small", width: 1440 },
  { name: "02-live-256", thread: "workflow-live", width: 1440 },
  { name: "03-expanded-row", thread: "workflow-live", width: 1440 },
  { name: "04-success-receipt", thread: "workflow-finished", width: 1440 },
  { name: "05-failed-receipt", thread: "workflow-failed", width: 1440 },
  { name: "06-anchored-readout", thread: "workflow-live", width: 1440 },
  { name: "07-relationships", thread: "workflow-live", width: 1440 },
  { name: "09-settings", thread: "workflow-small", width: 1440 },
  { name: "10-verbose-graph", thread: "workflow-small", width: 1440 },
  { name: "11-live-narrow", thread: "workflow-live", width: 800 },
  { name: "12-receipt-narrow", thread: "workflow-failed", width: 800 },
  { name: "13-running-fold", thread: "workflow-live", width: 1440 },
  { name: "14-relationships-phases", thread: "workflow-live", width: 1440 },
  { name: "15-settings-workflow", thread: "workflow-small", width: 1440 },
  { name: "16-settings-preset-editor", thread: "workflow-small", width: 1440 },
  { name: "17-settings-ultracode", thread: "workflow-small", width: 1440 },
  { name: "18-plan-review", thread: "workflow-review", width: 1440 },
] as const;

async function quiet() {
  let previous = -1;
  await vi.waitFor(
    () => {
      const current = commitsSoFar();
      const settled = previous === current;
      previous = current;
      expect(settled).toBe(true);
    },
    { interval: 100, timeout: 15_000 },
  );
}

it.runIf(import.meta.env.VITE_T3_WORKFLOW_FULL_WINDOW === "1").each(views)(
  "full-window workflow: $name",
  async ({ name, thread, width }) => {
    using _clock = fakeTimers({ toFake: ["Date"], now: WORKFLOW_QA_NOW });
    await page.viewport(width, 900);
    await commands.mockWorkflowAcpIcon(true);
    await commands.setMediaPreferences({ forcedColors: "none", reducedMotion: "reduce" });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      verboseWorkflowGraph: name === "10-verbose-graph",
    });
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread}`] }),
    );
    await router.load();
    const container = document.createElement("div");
    container.style.cssText = `height:900px;width:${width}px;`;
    // AppRoot owns the real router.
    await using screen = await render(<AppRoot router={router} />, { container, router: false });
    if (thread === "workflow-review") {
      await expect
        .element(page.getByRole("region", { name: "Workflow review: Fix the sync bug" }))
        .toBeVisible();
    } else {
      await vi.waitFor(() => {
        expect(
          container.querySelector("[data-workflow-opening]"),
          container.textContent ?? "",
        ).not.toBeNull();
      });
      await expect
        .element(
          page.elementLocator(container).getByRole("heading", { name: /Audit (4|256) agents/ }),
        )
        .toBeVisible();
    }
    await expect.element(page.getByTestId("composer-editor")).toBeVisible();
    await document.fonts.ready;
    await quiet();
    const opening = container.querySelector<HTMLElement>("[data-workflow-opening]");
    if (thread === "workflow-live") opening!.scrollIntoView({ block: "start" });
    if (name === "03-expanded-row") {
      await userEvent.click(screen.getByRole("button", { name: /Phases 1–8 · 128 done/ }));
      expect(container.querySelectorAll("[data-workflow-dot]")).toHaveLength(176);
      opening!.scrollIntoView({ block: "start" });
    }
    if (name === "13-running-fold") {
      await userEvent.click(screen.getByRole("button", { name: /^Phases 11–12 · 32 running/ }));
      expect(container.querySelectorAll("[data-workflow-dot]")).toHaveLength(80);
      opening!.scrollIntoView({ block: "start" });
    }
    if (name === "06-anchored-readout") {
      const cell = container.querySelector<HTMLButtonElement>('[data-workflow-dot="task-255"]')!;
      cell.scrollIntoView({ block: "center" });
      await quiet();
      const boundary = container.querySelector("[data-chat-readout-boundary]")!;
      let scroller: HTMLElement | null = cell.parentElement;
      while (scroller && !["auto", "scroll"].includes(getComputedStyle(scroller).overflowY))
        scroller = scroller.parentElement;
      expect(scroller).not.toBeNull();
      scroller!.scrollTop +=
        cell.getBoundingClientRect().bottom - (boundary.getBoundingClientRect().bottom - 24);
      await act(() => cell.focus({ preventScroll: true }));
      await expect.element(page.getByRole("note", { name: "Agent details" })).toBeVisible();
      await vi.waitFor(() => {
        const popup = document.querySelector("[data-workflow-readout]")!.getBoundingClientRect();
        const boundary = container
          .querySelector("[data-chat-readout-boundary]")!
          .getBoundingClientRect();
        expect(popup.bottom).toBeLessThanOrEqual(boundary.bottom);
        expect(popup.bottom).toBeLessThanOrEqual(cell.getBoundingClientRect().top);
        expect(cell.getBoundingClientRect().bottom).toBeLessThanOrEqual(boundary.bottom);
      });
    }
    if (name === "07-relationships" || name === "14-relationships-phases") {
      await userEvent.click(
        page.getByRole("button", { name: "Expand Audit 256 agents", exact: true }),
      );
      await expect
        .element(page.getByRole("button", { name: "Collapse Phase 9 phase, running", exact: true }))
        .toBeInTheDocument();
    }
    if (name === "14-relationships-phases") {
      // Folds the running phases' agent lists so every phase row and its bar is in view.
      for (const phase of [9, 10, 11, 12])
        await userEvent.click(
          page.getByRole("button", { name: `Collapse Phase ${phase} phase, running`, exact: true }),
        );
      expect(
        page.getByRole("button", { name: /^Expand Phase \d+ phase,/ }).elements(),
      ).toHaveLength(16);
      page
        .getByRole("button", { name: /^Expand Phase 16 phase,/ })
        .element()
        .scrollIntoView({ block: "end" });
      // At the panel's default width each bar keeps its size and no row grows. The before/after
      // comparison also runs this view on heads that have no bars.
      const rows = page.getByRole("button", { name: /^Expand Phase \d+ phase,/ }).elements();
      const bars = rows.flatMap((row) => [...row.querySelectorAll("[data-workflow-track]")]);
      if (bars.length > 0) {
        expect(
          bars.map((bar) => [
            bar.getBoundingClientRect().width,
            bar.getBoundingClientRect().height,
          ]),
        ).toEqual(Array.from({ length: 16 }, () => [56, 2]));
      }
      expect(rows.map((row) => row.getBoundingClientRect().height)).toEqual(
        Array.from({ length: 16 }, () => 32),
      );
    }
    if (name === "09-settings") {
      await act(() => router.navigate({ to: "/settings/chat" }));
      const toggle = page.getByRole("switch", { name: "Verbose workflow graph" });
      await expect.element(toggle).toBeInTheDocument();
      toggle.element().scrollIntoView({ block: "center" });
    }
    if (name === "15-settings-workflow" || name === "16-settings-preset-editor") {
      await act(() => router.navigate({ to: "/settings/agents" }));
      await expect.element(page.getByRole("switch", { name: "Enable workflows" })).toBeChecked();
      await expect
        .element(page.getByRole("switch", { name: "Workflow worker default: Worker" }))
        .toBeChecked();
    }
    if (name === "16-settings-preset-editor") {
      await userEvent.click(page.getByRole("button", { name: "Edit Worker", exact: true }));
      await expect
        .element(page.getByRole("textbox", { name: "Preset name" }))
        .toHaveValue("Worker");
      page.getByRole("form", { name: "Worker preset" }).element().scrollIntoView({ block: "end" });
    }
    if (name === "17-settings-ultracode") {
      await act(() => router.navigate({ to: "/settings/threads" }));
      const ultracode = page.getByRole("combobox", { name: "Ultracode" });
      await expect.element(ultracode).toBeEnabled();
      ultracode.element().scrollIntoView({ block: "center" });
    }
    if (name === "10-verbose-graph") {
      await userEvent.click(page.getByRole("button", { name: "Graph details", exact: true }));
      await expect
        .element(page.elementLocator(container.querySelector("[data-workflow-waves]")!))
        .toBeVisible();
    }
    if (name !== "06-anchored-readout") {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      await commands.resetPointer();
    }
    await quiet();
    if (name === "03-expanded-row") {
      screen
        .getByRole("button", { name: /Phases 1–8 · 128 done/ })
        .element()
        .scrollIntoView({ block: "center" });
      await quiet();
    }
    await page.elementLocator(document.body).screenshot({
      path: `${server.config.root}/../../.logs/workflow-qa/full-window/${name}__dark-${width}.png`,
    });
  },
);

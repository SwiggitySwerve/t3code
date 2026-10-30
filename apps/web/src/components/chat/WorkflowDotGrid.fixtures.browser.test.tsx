import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";
import { deriveWorkflowProgress } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  workflowIdentityStatesFixture,
  workflowModelGlyphFixture,
  workflowScaleFixture,
  workflowScriptProgressFixture,
  workflowPlannedIdentityFixture,
  workflowCollapseFixture,
  workflowFixture,
} from "../../../test/workflow-fixtures/workflowFixtures";
import "../../index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { captureSurface } from "../../../test/workflow-fixtures/capture";
import { readQaAtom } from "../../../test/workflow-fixtures/atoms";
import { workflowClientSettings } from "../../../test/workflow-fixtures/settings";
import { expandWorkflowPhases } from "../../../test/workflow-fixtures/interactions";
import {
  WorkflowBlockSurface,
  WorkflowComposerEdgeSurface,
  WorkflowModelGlyphSurface,
} from "../../../test/workflow-fixtures/surfaces";
import { WorkflowGraphSettingsRow } from "../settings/WorkflowGraphSettingsRow";
import { SettingsSection } from "../settings/settingsLayout";
import { persistClientSettingsPatch, useMergedSettings } from "../../hooks/useSettings";

const state = vi.hoisted(() => ({ persist: vi.fn(async () => {}) }));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) =>
    readQaAtom(atom, selector)) as never,
}));
vi.mock(import("../settings/useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((selector) =>
    useMergedSettings(
      DEFAULT_SERVER_SETTINGS,
      selector,
    )) as typeof import("../settings/useScopedSettings").useScopedSettings,
  useUpdateScopedSettings: () => (patch) => {
    void persistClientSettingsPatch(patch, state.persist);
  },
  useClearScopedSettings: () => () => {},
  useClearProjectOverrides: () => () => {},
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => false,
  useEnvironmentsWithScope: () => new Set(),
}));

function SettingsSurface() {
  return (
    <div className="mx-auto max-w-3xl bg-background px-4 py-3 text-foreground" data-qa-settings>
      <SettingsSection id="workflows" title="Workflows">
        <WorkflowGraphSettingsRow />
      </SettingsSection>
    </div>
  );
}

it("toggles and resets the client preference while the workflow is mounted", async () => {
  state.persist.mockClear();
  using _settings = workflowClientSettings();
  await using screen = await render(
    <>
      <SettingsSurface />
      <WorkflowBlockSurface kind="graph" agentCount={4} />
    </>,
  );
  const toggle = screen.getByRole("switch", { name: "Verbose workflow graph" });
  await expect.element(toggle).not.toBeChecked();
  await expect
    .element(screen.getByRole("button", { name: "Graph details", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(toggle);
  await expect.element(toggle).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
  expect(screen.container.querySelector("[data-workflow-waves]")).not.toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Reset verbose workflow graph/ }));
  await expect.element(toggle).not.toBeChecked();
  expect(screen.container.querySelector("[data-workflow-waves]")).toBeNull();
  expect(state.persist).toHaveBeenLastCalledWith(
    expect.objectContaining({ verboseWorkflowGraph: false }),
  );
});

it.each([
  "running-256",
  "running-1024",
  "expanded",
  "finished",
  "failed-receipt",
  "live-attention",
  "running-4",
] as const)("collapsed workflow: %s", async (state) => {
  const count = state === "running-1024" ? 1024 : state === "running-4" ? 4 : 256;
  const fixture =
    state === "live-attention"
      ? workflowFixture("graph", "retrying")
      : workflowCollapseFixture(
          "graph",
          count,
          state === "finished" ? "completed" : state === "failed-receipt" ? "failed" : "running",
        );
  await captureSurface({
    surface: "workflow-collapse",
    state,
    selector: "[data-workflow-opening]",
    frame: "[data-qa-column]",
    element: () => <WorkflowBlockSurface kind="graph" fixture={fixture} />,
    settle: async (screen) => {
      if (state === "expanded") {
        const button = screen.container.querySelector<HTMLButtonElement>(
          "[data-workflow-phase-disclosure]",
        )!;
        await userEvent.click(button);
        await expect.element(button).toHaveAttribute("aria-expanded", "true");
      }
    },
  });
});

it.each([4, 40, 256, 1024] as const)("dot grid final: %i agents", async (count) => {
  await captureSurface({
    surface: "workflow-dot-grid",
    state: `agents-${count}`,
    selector: "[data-workflow-opening]",
    frame: "[data-qa-column]",
    element: () => <WorkflowBlockSurface kind="graph" agentCount={count} />,
  });
});

it.each([
  "planned-256",
  "planned-states",
  "planned-stopped",
  "planned-fallback",
  "planned-script",
] as const)("planned identities: %s", async (variant) => {
  await captureSurface({
    surface: "workflow-dot-grid",
    state: variant,
    selector: "[data-workflow-opening]",
    frame: variant === "planned-fallback" ? "[data-qa-readout-frame]" : "[data-qa-column]",
    ...(variant === "planned-fallback" ? { keepInteraction: true } : {}),
    element: () => (
      <div
        className={variant === "planned-fallback" ? "bg-background pb-32" : undefined}
        data-qa-readout-frame
      >
        <WorkflowBlockSurface
          kind={variant === "planned-script" ? "script" : "graph"}
          fixture={workflowPlannedIdentityFixture(
            variant === "planned-script" ? "script" : "graph",
            variant === "planned-256" || variant === "planned-script" ? 256 : "states",
            variant === "planned-stopped",
          )}
        />
      </div>
    ),
    settle: async (screen) => {
      if (variant !== "planned-fallback") return;
      await act(() =>
        screen.getByRole("button", { name: "Open Sol running", exact: true }).element().focus(),
      );
      await expect
        .element(
          page.getByText("Changed from planned: CLI Proxy · Claude Opus 5.5", { exact: true }),
        )
        .toBeVisible();
    },
  });
});

it("replaces an unspawned plan with actual identity and explains a fallback", async () => {
  const fixture = workflowPlannedIdentityFixture("graph", "states");
  await using screen = await render(<WorkflowBlockSurface kind="graph" fixture={fixture} />);
  await expandWorkflowPhases(screen);
  const queued = screen.getByRole("button", { name: "Open Waiting for agent", exact: true });
  await expect
    .element(queued)
    .toHaveAccessibleDescription(
      expect.stringMatching(/^queued, Planned, CLI Proxy, Claude Opus 5.5/),
    );
  expect(queued.element().querySelector("[data-workflow-planned]")).not.toBeNull();
  const before = queued.element().getBoundingClientRect().toJSON();
  await userEvent.hover(queued);
  await expect
    .element(page.getByText("Planned: CLI Proxy · Claude Opus 5.5", { exact: true }))
    .toBeVisible();
  expect(queued.element().getBoundingClientRect().toJSON()).toEqual(before);
  const missing = screen.getByRole("button", { name: "Open Agent not run", exact: true });
  expect(missing.element().querySelector("[data-workflow-planned]")).toBeNull();
  expect(missing.element().querySelector('[data-workflow-identity="generic"]')).not.toBeNull();
  const actual = screen.getByRole("button", { name: "Open Sol running", exact: true });
  expect(actual.element().querySelector("[data-workflow-planned]")).toBeNull();
  await userEvent.hover(actual);
  await expect
    .element(page.getByText("Changed from planned: CLI Proxy · Claude Opus 5.5", { exact: true }))
    .toBeVisible();
  const progress = deriveWorkflowProgress(fixture.group);
  const task = progress.phases
    .flatMap((phase) => phase.tasks)
    .find((task) => task.id === "queued")!;
  const running = {
    ...fixture.group.graph!.waves[0]![0]!.member!,
    graphNodeKey: task.id,
    title: task.label,
  };
  const group = {
    ...fixture.group,
    graph: {
      ...fixture.group.graph!,
      waves: fixture.group.graph!.waves.map((wave) =>
        wave.map((node) =>
          node.key === task.id ? { ...node, state: "running" as const, member: running } : node,
        ),
      ),
    },
  };
  using _timers = fakeTimers();
  await screen.rerender(
    <WorkflowBlockSurface
      kind="graph"
      fixture={{ ...fixture, group, opening: { ...fixture.opening, group } }}
    />,
  );
  await act(() => vi.advanceTimersByTime(1000));
  await userEvent.hover(queued);
  expect(queued.element().querySelector("[data-workflow-planned]")).toBeNull();
  expect(queued.element().querySelector('[data-model-glyph="gpt-sol"]')).not.toBeNull();
  await expect
    .element(page.getByText("Changed from planned: CLI Proxy · Claude Opus 5.5", { exact: true }))
    .toBeVisible();
});

it.each(["stopped", "mixed-models", "verbose", "failure-focus"] as const)(
  "dot grid final: %s",
  async (variant) => {
    await captureSurface({
      surface: "workflow-dot-grid",
      state: variant,
      verboseGraph: variant === "verbose",
      selector: "[data-workflow-opening]",
      frame: variant === "failure-focus" ? "[data-qa-readout-frame]" : "[data-qa-column]",
      ...(variant === "failure-focus" ? { keepInteraction: true as const } : {}),
      element: () =>
        variant === "mixed-models" ? (
          <WorkflowModelGlyphSurface />
        ) : variant === "stopped" ? (
          <WorkflowBlockSurface
            kind="graph"
            fixture={workflowScaleFixture("graph", 40, false, {
              identities: "diverse",
              stopped: true,
            })}
          />
        ) : variant === "failure-focus" ? (
          <div className="bg-background pb-32" data-qa-readout-frame>
            <div style={{ contain: "paint layout style" }}>
              <WorkflowBlockSurface kind="graph" agentCount={40} />
            </div>
          </div>
        ) : (
          <WorkflowBlockSurface kind="graph" agentCount={40} />
        ),
      settle: async (screen) => {
        if (variant === "verbose")
          await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
        if (variant === "failure-focus") {
          await userEvent.tab();
          await act(() =>
            screen.getByRole("button", { name: "Open Agent 40", exact: true }).element().focus(),
          );
          await expect.element(page.getByText("Agent 40 · failed", { exact: true })).toBeVisible();
        }
      },
    });
  },
);

it.each(["running", "failed"] as const)("dot grid final: %s glyph cues", async (cue) => {
  await captureSurface({
    surface: "workflow-dot-grid",
    state: `${cue}-glyphs`,
    selector: "[data-workflow-opening]",
    frame: "[data-qa-column]",
    element: () => <WorkflowBlockSurface kind="graph" fixture={workflowModelGlyphFixture(cue)} />,
  });
});

it("dot grid final: composer edge", async () => {
  await captureSurface({
    surface: "workflow-dot-grid",
    state: "composer-edge",
    selector: "[data-workflow-opening]",
    frame: "[data-qa-chat-frame]",
    keepInteraction: true,
    element: () => <WorkflowComposerEdgeSurface />,
    settle: async (screen) => {
      const scroll = screen.container.querySelector<HTMLElement>("[data-qa-chat-scroll]")!;
      const agent = screen.getByRole("button", { name: "Open Agent 40", exact: true });
      await act(() => {
        scroll.scrollTop = scroll.scrollHeight;
        agent.element().focus({ preventScroll: true });
      });
      const before = agent.element().getBoundingClientRect().toJSON();
      const readout = page.getByRole("note", { name: "Agent details" });
      await expect.element(readout).toBeVisible();
      await vi.waitFor(() => {
        const box = readout.element().getBoundingClientRect();
        const cell = agent.element().getBoundingClientRect();
        const footer = screen.container
          .querySelector("[data-qa-composer]")!
          .getBoundingClientRect();
        expect(box.bottom).toBeLessThanOrEqual(cell.top);
        expect(cell.top - box.bottom).toBeLessThanOrEqual(8);
        expect(box.bottom).toBeLessThan(footer.top);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(innerWidth);
      });
      expect(agent.element().getBoundingClientRect().toJSON()).toEqual(before);
      expect(document.querySelectorAll("[data-workflow-readout]")).toHaveLength(1);
    },
  });
});

it.each([false, true])("dot grid final: settings enabled=%s", async (enabled) => {
  state.persist.mockClear();
  await captureSurface({
    surface: "workflow-dot-grid-settings",
    state: enabled ? "on" : "off",
    router: true,
    selector: "#workflows",
    frame: "[data-qa-settings]",
    element: () => <SettingsSurface />,
    settle: async (screen) => {
      if (enabled)
        await userEvent.click(screen.getByRole("switch", { name: "Verbose workflow graph" }));
      await expect
        .element(screen.getByRole("switch", { name: "Verbose workflow graph" }))
        .toHaveAttribute("aria-checked", String(enabled));
    },
  });
});

it.each(["states", "states-grayscale", "states-forced-colors"] as const)(
  "dot grid final: %s",
  async (variant) => {
    await using _media = {
      [Symbol.asyncDispose]: () =>
        commands.setMediaPreferences({ forcedColors: "none", reducedMotion: "no-preference" }),
    };
    if (variant === "states-forced-colors")
      await commands.setMediaPreferences({ forcedColors: "active", reducedMotion: "reduce" });
    const fixture = workflowIdentityStatesFixture();
    expect(
      new Set(
        deriveWorkflowProgress(fixture.group).phases.flatMap((phase) =>
          phase.tasks.map((task) => task.state),
        ),
      ),
    ).toEqual(new Set(["done", "running", "failed", "queued", "stopped", "skipped"]));
    await captureSurface({
      surface: "workflow-dot-grid",
      state: variant,
      selector: "[data-workflow-opening]",
      frame: "[data-qa-column]",
      element: () => (
        <div style={variant === "states-grayscale" ? { filter: "grayscale(1)" } : undefined}>
          <WorkflowBlockSurface kind="graph" fixture={fixture} />
        </div>
      ),
      settle: async (screen) => {
        await vi.waitFor(() =>
          expect(
            screen.container.querySelector('[data-workflow-image-status="loaded"]'),
          ).not.toBeNull(),
        );
      },
    });
  },
);

it("shows observed progress for an undeclared total and non-interactive script placeholders", async () => {
  const fixture = workflowScriptProgressFixture(false);
  await using screen = await render(<WorkflowBlockSurface kind="script" fixture={fixture} />);
  await expandWorkflowPhases(screen);
  expect(screen.container.querySelectorAll("[data-workflow-placeholder]")).toHaveLength(13);
  expect(
    screen.container.querySelectorAll(
      "[data-workflow-placeholder] button, [data-workflow-placeholder][data-workflow-dot]",
    ),
  ).toHaveLength(0);
  await screen.rerender(<WorkflowBlockSurface kind="script" agentCount={40} />);
  const bar = screen.getByRole("progressbar", { name: "Workflow tasks settled" });
  await expect.element(bar).toHaveAttribute("max", "40");
  await expect
    .element(bar)
    .toHaveAttribute("aria-valuetext", expect.stringContaining("total unknown"));
  expect(screen.getByRole("progressbar").elements()).toHaveLength(1);
});

it("dot grid final: undeclared phase", async () => {
  await captureSurface({
    surface: "workflow-dot-grid",
    state: "undeclared-phase",
    selector: "[data-workflow-opening]",
    frame: "[data-qa-column]",
    element: () => <WorkflowBlockSurface kind="script" agentCount={40} />,
  });
});

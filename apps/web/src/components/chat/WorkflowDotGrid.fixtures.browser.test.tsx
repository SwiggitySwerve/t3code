import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";
import { deriveWorkflowProgress } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  workflowIdentityStatesFixture,
  workflowScriptProgressFixture,
} from "../../../test/workflow-fixtures/workflowFixtures";
import "../../index.css";
import { act, render } from "../../../test/render";
import { captureSurface } from "../../../test/workflow-fixtures/capture";
import { readQaAtom } from "../../../test/workflow-fixtures/atoms";
import { workflowClientSettings } from "../../../test/workflow-fixtures/settings";
import {
  WorkflowBlockSurface,
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

it.each([4, 40, 256, 1024] as const)("dot grid final: %i agents", async (count) => {
  await captureSurface({
    surface: "workflow-dot-grid",
    state: `agents-${count}`,
    selector: "[data-workflow-opening]",
    frame: "[data-qa-column]",
    element: () => <WorkflowBlockSurface kind="graph" agentCount={count} />,
  });
});

it.each(["stopped", "mixed-models", "verbose", "failure-focus"] as const)(
  "dot grid final: %s",
  async (variant) => {
    await captureSurface({
      surface: "workflow-dot-grid",
      state: variant,
      verboseGraph: variant === "verbose",
      selector: "[data-workflow-opening]",
      frame: "[data-qa-column]",
      ...(variant === "failure-focus" ? { keepInteraction: true as const } : {}),
      element: () =>
        variant === "mixed-models" ? (
          <WorkflowModelGlyphSurface />
        ) : variant === "stopped" ? (
          <WorkflowBlockSurface kind="graph" variant="stopped" />
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

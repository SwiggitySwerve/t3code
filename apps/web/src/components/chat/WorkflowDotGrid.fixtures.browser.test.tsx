import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
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
    themes: ["dark"],
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
      themes: ["dark"],
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
    themes: ["dark"],
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

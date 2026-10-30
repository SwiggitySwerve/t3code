import { expect, it, vi } from "vite-plus/test";
import { deriveWorkflowProgress } from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId } from "@t3tools/contracts";
import { commands, page, userEvent } from "vite-plus/test/browser";
import "../../index.css";
import { workflowClientSettings } from "../../../test/workflow-fixtures/settings";
import { act, render } from "../../../test/render";
import { readQaAtom } from "../../../test/workflow-fixtures/atoms";
import { captureSurface } from "../../../test/workflow-fixtures/capture";
import { workflowModelGlyphFixture } from "../../../test/workflow-fixtures/workflowFixtures";
import { WorkflowProgressOverview } from "./WorkflowProgressOverview";
import {
  WorkflowModelGlyphSurface,
  scrollWavesToNode,
} from "../../../test/workflow-fixtures/surfaces";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) =>
    readQaAtom(atom, selector)) as never,
}));

it("shows every agent identity, including namespace aliases and generic fallbacks", async () => {
  const progress = deriveWorkflowProgress(workflowModelGlyphFixture().group);
  const models = [
    ["gpt-6.1-sol", "openai.gpt-6.1-sol", "openai/gpt-6.1-sol", "gpt-6-luna"],
    ["gpt-6-sol", "gpt-6.1-sol", "vendor/custom-model", "custom-model"],
  ];
  await using screen = await render(
    <WorkflowProgressOverview
      progress={{
        ...progress,
        phases: progress.phases.slice(0, 2).map((phase, phaseIndex) => ({
          ...phase,
          tasks: phase.tasks.map((task, taskIndex) => ({
            ...task,
            member: { ...task.member!, model: models[phaseIndex]![taskIndex]! },
          })),
        })),
      }}
      environmentId={EnvironmentId.make("qa")}
      onOpenThread={() => {}}
    />,
  );
  const [aliases, distinct] = screen.container.querySelectorAll("[data-workflow-phase]");
  expect(aliases!.querySelectorAll('[data-model-glyph="gpt-sol"]')).toHaveLength(3);
  expect(aliases!.querySelector('[data-model-glyph="gpt-luna"]')).not.toBeNull();
  expect(aliases!.querySelector('[aria-label*="more models:"]')).toBeNull();
  expect(distinct!.querySelectorAll('[data-model-glyph="gpt-sol"]')).toHaveLength(2);
  expect(distinct!.querySelector("header [data-model-glyph]")).toBeNull();
  await expect
    .element(screen.getByRole("button", { name: "Open Astra architect", exact: true }))
    .toHaveAccessibleDescription(expect.stringContaining("6.1 Sol"));
});

it.each([400, 736])(
  "preserves model and provider identity at %ipx across overview and graph",
  async (width) => {
    const previous = { width: window.innerWidth, height: window.innerHeight };
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
    };
    await page.viewport(width, 900);
    await using _media = {
      [Symbol.asyncDispose]: () =>
        commands.setMediaPreferences({ forcedColors: "none", reducedMotion: "no-preference" }),
    };
    await commands.setMediaPreferences({
      forcedColors: width === 400 ? "active" : "none",
      reducedMotion: "reduce",
    });
    using _settings = workflowClientSettings(true);
    await using screen = await render(<WorkflowModelGlyphSurface />);
    const headline = screen.container.querySelector('[aria-live="polite"]')!;
    expect(headline.querySelector("[data-model-glyph]")?.getAttribute("data-model-glyph")).toBe(
      "gpt-sol",
    );
    expect(headline.textContent).toContain("Phase 3 · 4 running");
    const overview = screen.container.querySelector<HTMLElement>("[data-workflow-overview]")!;
    expect(overview.querySelectorAll("[data-workflow-dot]")).toHaveLength(12);
    expect(overview.querySelector("[data-workflow-legend-overflow] .sr-only")).not.toBeNull();
    expect(
      overview.querySelector("[data-workflow-legend-overflow] .sr-only")?.textContent,
    ).toContain("CLI Proxy · Opus 5.5");
    expect(
      overview
        .querySelector("[data-workflow-legend-overflow] .sr-only")
        ?.getAttribute("aria-hidden"),
    ).toBeNull();
    expect(
      screen
        .getByRole("region", { name: "Phase 1 phase", exact: true })
        .getByRole("img")
        .elements(),
    ).toHaveLength(4);
    const opus = screen.getByRole("button", { name: "Open Opus planner", exact: true });
    await expect.element(opus).toHaveAccessibleDescription(expect.stringContaining("CLI Proxy"));
    await userEvent.tab();
    await act(() => opus.element().focus());
    await expect.element(page.getByText("CLI Proxy · Opus 5.5", { exact: true })).toBeVisible();
    const unknown = screen.getByRole("button", { name: "Open Unknown model", exact: true });
    await expect
      .element(unknown)
      .toHaveAccessibleDescription(expect.stringContaining("Work Cursor"));
    const custom = screen.getByRole("button", { name: "Open Unknown harness", exact: true });
    await expect
      .element(custom)
      .toHaveAccessibleDescription(expect.stringContaining("Research Lab, custom-model"));
    expect(custom.element().querySelector('[data-workflow-identity="generic"]')).not.toBeNull();
    expect(custom.element().textContent).not.toContain("RL");
    await expect
      .element(screen.getByRole("button", { name: "Open Missing model", exact: true }))
      .toHaveAccessibleDescription(expect.stringContaining("Unknown model"));
    await expect
      .element(screen.getByRole("button", { name: "Open Unavailable instance", exact: true }))
      .toHaveAccessibleDescription(expect.stringContaining("Provider removed"));
    expect(overview.querySelector("[data-provider-package-icon]")).not.toBeNull();
    expect(overview.scrollWidth).toBeLessThanOrEqual(overview.clientWidth);

    await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
    const graphSol = screen.getByRole("button", { name: "Open Sol analyst, passed", exact: true });
    await expect.element(graphSol.getByText("6.1 Sol", { exact: true })).toBeVisible();
    await expect
      .element(graphSol)
      .toHaveAccessibleDescription(expect.stringContaining("cliproxy / openai.gpt-6.1-sol"));
    await scrollWavesToNode(screen.container, "model-4");
    const graphOpus = screen.getByRole("button", {
      name: "Open Opus planner, passed",
      exact: true,
    });
    await expect
      .element(graphOpus.getByRole("img", { name: "Claude Opus", exact: true }))
      .toBeVisible();
    await expect
      .element(graphOpus)
      .toHaveAccessibleDescription(expect.stringContaining("cliproxy / claude-opus-5-5"));
    const graphSonnet = screen.getByRole("button", {
      name: "Open Sonnet researcher, passed",
      exact: true,
    });
    await expect.element(graphSonnet.getByText("Sonnet 4.6", { exact: true })).toBeVisible();
    await expect
      .element(graphSonnet)
      .toHaveAccessibleDescription(
        expect.stringContaining("cliproxy / anthropic/claude-sonnet-4-6"),
      );
    await scrollWavesToNode(screen.container, "model-8");
    const graphUnknown = screen.getByRole("button", {
      name: "Open Unknown model, running",
      exact: true,
    });
    await expect
      .element(graphUnknown)
      .toHaveAccessibleDescription(expect.stringContaining("Work Cursor"));
    expect(graphUnknown.element().querySelector("[data-provider-package-icon]")).not.toBeNull();
    expect(graphUnknown.element().querySelector("[data-model-glyph]")).toBeNull();
    await expect
      .element(graphUnknown.getByText("vendor/claude-opus-5-5-custom", { exact: true }))
      .toBeVisible();
    for (const identity of screen.container.querySelectorAll<HTMLElement>(
      "[data-workflow-agent-identity]",
    )) {
      expect(identity.scrollWidth).toBeLessThanOrEqual(identity.clientWidth);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);

it("updates one inline readout across pointer and keyboard navigation", async () => {
  await using screen = await render(<WorkflowModelGlyphSurface />);
  const opus = screen.getByRole("button", { name: "Open Opus planner", exact: true });
  const haiku = screen.getByRole("button", { name: "Open Haiku verifier", exact: true });
  await userEvent.hover(opus);
  await expect
    .element(
      screen
        .getByRole("note", { name: "Agent details" })
        .getByText("CLI Proxy · Opus 5.5", { exact: true }),
    )
    .toBeVisible();
  await userEvent.hover(haiku);
  await expect
    .element(
      screen
        .getByRole("note", { name: "Agent details" })
        .getByText("Work Cursor · Haiku 5.5", { exact: true }),
    )
    .toBeVisible();
  await userEvent.tab();
  await act(() => opus.element().focus());
  await userEvent.keyboard("{ArrowRight}");
  const sonnet = screen.getByRole("button", { name: "Open Sonnet researcher", exact: true });
  await expect.element(sonnet).toHaveFocus();
  await expect
    .element(
      screen
        .getByRole("note", { name: "Agent details" })
        .getByText("CLI Proxy · Sonnet 4.6", { exact: true }),
    )
    .toBeVisible();
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(
      screen
        .getByRole("note", { name: "Agent details" })
        .getByText("Work Cursor · Fable 5.1", { exact: true }),
    )
    .toBeVisible();
});

it.each(["overview", "graph", "graph-fallbacks"] as const)(
  "model identities fixture: %s",
  async (state) => {
    await captureSurface({
      surface: "workflow-model-identities",
      state,
      selector: state === "overview" ? "[data-workflow-overview]" : "[data-workflow-waves]",
      frame: "[data-qa-column]",
      element: () => <WorkflowModelGlyphSurface />,
      verboseGraph: state.startsWith("graph"),
      settle: async (screen) => {
        if (state.startsWith("graph")) {
          await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
          if (state === "graph-fallbacks") await scrollWavesToNode(screen.container, "model-8");
        }
      },
    });
  },
);

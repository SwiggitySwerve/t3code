import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";
import "../../index.css";
import { render, type Screen } from "../../../test/render";
import { readQaAtom } from "../../../test/workflow-fixtures/atoms";
import { captureSurface } from "../../../test/workflow-fixtures/capture";
import {
  WorkflowModelGlyphSurface,
  scrollWavesToNode,
} from "../../../test/workflow-fixtures/surfaces";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) =>
    readQaAtom(atom, selector)) as never,
}));

async function expandAgents(screen: Screen) {
  for (const button of screen.getByRole("button", { name: / agents$/ }).all()) {
    if (button.element().getAttribute("aria-expanded") === "false") await userEvent.click(button);
  }
}

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
    await using screen = await render(<WorkflowModelGlyphSurface />);
    await expandAgents(screen);
    const overview = screen.container.querySelector<HTMLElement>("[data-workflow-overview]")!;
    expect(overview.querySelectorAll("[data-model-glyph]")).toHaveLength(8);
    const opus = screen.getByRole("button", { name: "Open Opus planner", exact: true });
    await expect.element(opus).toHaveAccessibleDescription(expect.stringContaining("CLI Proxy"));
    await expect.element(opus.getByRole("img", { name: "Claude Opus", exact: true })).toBeVisible();
    await expect
      .element(opus.getByRole("img", { name: "Provider: CLI Proxy (cliproxy)", exact: true }))
      .toBeVisible();
    expect(
      opus
        .element()
        .querySelector("[data-provider-accent-color]")
        ?.getAttribute("data-provider-accent-color"),
    ).toBe("#7c3aed");
    const unknown = screen.getByRole("button", { name: "Open Unknown model", exact: true });
    await expect
      .element(unknown)
      .toHaveAccessibleDescription(expect.stringContaining("Work Cursor"));
    expect(unknown.element().querySelector("[data-model-glyph]")).toBeNull();
    expect(unknown.element().querySelector("[data-provider-package-icon]")).not.toBeNull();
    const custom = screen.getByRole("button", { name: "Open Unknown harness", exact: true });
    await expect
      .element(custom)
      .toHaveAccessibleDescription(expect.stringContaining("lab-runner / custom-model"));
    expect(custom.element().textContent).toContain("RL");
    const missing = screen.getByRole("button", { name: "Open Missing model", exact: true });
    await expect
      .element(missing)
      .toHaveAccessibleDescription(expect.stringContaining("Unknown model"));
    expect(missing.element().querySelector("svg")).not.toBeNull();
    await expect
      .element(screen.getByRole("button", { name: "Open Unavailable instance", exact: true }))
      .toHaveAccessibleDescription(expect.stringContaining("retired-instance"));
    expect(overview.scrollWidth).toBeLessThanOrEqual(overview.clientWidth);

    await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
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
    for (const identity of screen.container.querySelectorAll<HTMLElement>(
      "[data-workflow-agent-identity]",
    )) {
      expect(identity.scrollWidth).toBeLessThanOrEqual(identity.clientWidth);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);

it.each(["overview", "graph", "graph-fallbacks"] as const)(
  "model identities fixture: %s",
  async (state) => {
    await captureSurface({
      surface: "workflow-model-identities",
      state,
      selector: state === "overview" ? "[data-workflow-overview]" : "[data-workflow-waves]",
      frame: "[data-qa-column]",
      element: () => <WorkflowModelGlyphSurface />,
      settle: async (screen) => {
        if (state === "overview") await expandAgents(screen);
        else {
          await userEvent.click(screen.getByRole("button", { name: "Graph details", exact: true }));
          if (state === "graph-fallbacks") await scrollWavesToNode(screen.container, "model-8");
        }
      },
    });
  },
);

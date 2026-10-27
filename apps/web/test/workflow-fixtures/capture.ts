/**
 * Screenshot helper for the workflow fixture browser tests. `captureSurface` renders one surface
 * state in every theme and width of the QA matrix and throws if the selector matches no element.
 * With `VITE_T3_WORKFLOW_QA=1` it saves each frame as a PNG with a JSON sidecar under
 * `.logs/workflow-qa/frames`; a plain run renders one light frame and runs the same checks.
 */
import type { ReactNode } from "react";
import {
  WORKFLOW_QA_THEMES,
  WORKFLOW_QA_VIEWPORTS,
  workflowQaFrameName,
  workflowQaFrameProblems,
  type WorkflowQaFrame,
  type WorkflowQaTheme,
} from "@t3tools/shared/testing/workflowQa";
import { vi } from "vite-plus/test";
import { commands, page, server } from "vite-plus/test/browser";

import { fakeTimers, render, type Screen } from "../render";
import { WORKFLOW_QA_NOW } from "./workflowFixtures";

const CAPTURE = import.meta.env.VITE_T3_WORKFLOW_QA === "1";
export class WorkflowQaSelectorError extends Error {
  override readonly name = "WorkflowQaSelectorError";
}

export interface SurfaceSpec {
  /** Lowercase words joined by hyphens, for example `workflow-block-graph`. */
  readonly surface: string;
  readonly state: string;
  /** Rendered once per theme and width. */
  readonly element: () => ReactNode;
  /** The component under test. Zero matches fail the capture; more than one does too. */
  readonly selector: string;
  /**
   * What to photograph when the subject has no background of its own (a transparent block in a
   * themed column). Must match exactly one element; defaults to the subject.
   */
  readonly frame?: string;
  /** Mounts the surface inside the test router, for components that read the location. */
  readonly router?: true;
  /** Search the whole document, for a surface that lives in a portal. */
  readonly within?: "container" | "document";
  /**
   * Interactions after mount and before the photograph, such as opening a disclosure. Afterwards
   * focus is dropped and the pointer is moved off the page, so a frame shows the surface at rest
   * and not whatever the last click left hovered or focused.
   */
  readonly settle?: (screen: Screen) => Promise<void>;
  /**
   * Keeps the focus and pointer `settle` left in place, for a state whose subject is that
   * interaction (a control that only exists while hovered). Name the state for it.
   */
  readonly keepInteraction?: true;
  /** The subject has a fixed width, so its frames must be identical at every viewport width. */
  readonly widthIndependent?: true;
  /** This state intentionally renders exactly like `of`; the CLI fails the capture if it stops. */
  readonly alias?: { readonly of: string; readonly reason: string };
}

function framesDirectory(): string {
  const root = server.config.root.replaceAll("\\", "/");
  const web = "/apps/web";
  if (!root.endsWith(web)) throw new Error(`Expected the web project root, got ${root}`);
  return `${root.slice(0, -web.length)}/.logs/workflow-qa/frames`;
}

/**
 * Switches off CSS transitions, animations and the text caret while a frame is taken, so a
 * photograph never catches a chevron mid-turn or a pulsing dot at a random phase. Nothing waits
 * for a frame; the styles simply have no duration.
 */
function stillMotion(): Disposable {
  const style = document.createElement("style");
  style.textContent =
    "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;}";
  document.head.append(style);
  return { [Symbol.dispose]: () => style.remove() };
}

/** Puts the document in a theme the way the app does (`.dark` on the root) and restores it. */
function applyTheme(theme: WorkflowQaTheme): Disposable {
  const root = document.documentElement;
  const wasDark = root.classList.contains("dark");
  const scheme = root.style.colorScheme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  return {
    [Symbol.dispose]() {
      root.classList.toggle("dark", wasDark);
      root.style.colorScheme = scheme;
    },
  };
}

async function recordFrame(
  spec: SurfaceSpec,
  screen: Screen,
  theme: WorkflowQaTheme,
  viewport: { readonly width: number; readonly height: number },
): Promise<WorkflowQaFrame> {
  const base = { surface: spec.surface, state: spec.state, theme, width: viewport.width };
  const name = workflowQaFrameName(base);
  const scope = spec.within === "document" ? document : screen.container;
  const one = (selector: string) => {
    const matches = scope.querySelectorAll<HTMLElement>(selector);
    if (matches.length !== 1) {
      throw new WorkflowQaSelectorError(
        `${name}: selector "${selector}" matched ${matches.length} elements, expected exactly one.`,
      );
    }
    return matches[0]!;
  };
  const subject = one(spec.selector);
  const frameSelector = spec.frame ?? spec.selector;
  const element = frameSelector === spec.selector ? subject : one(frameSelector);
  await document.fonts.ready;
  const html = document.documentElement;
  // The subject is measured at the matrix viewport, which is what the frame claims. The iframe
  // paints nothing below its own viewport, so a taller subject is photographed in a viewport as
  // high as itself; its layout must not change with that (`layout-shift`), or the picture would
  // not show what the matrix viewport renders.
  const rect = element.getBoundingClientRect();
  const layoutHeight = window.innerHeight;
  const needed = Math.ceil(rect.top + window.scrollY + rect.height);
  if (needed > layoutHeight) {
    await page.viewport(viewport.width, needed);
  }
  const framed = element.getBoundingClientRect();
  const frame: WorkflowQaFrame = {
    ...base,
    height: layoutHeight,
    capture: {
      viewportHeight: window.innerHeight,
      top: Math.round(framed.top + window.scrollY),
      height: Math.round(framed.height),
    },
    selector: spec.selector,
    matchCount: 1,
    frameSelector,
    file: `${name}.png`,
    box: { width: Math.round(rect.width), height: Math.round(rect.height) },
    htmlDark: html.classList.contains("dark"),
    innerWidth: window.innerWidth,
    pageOverflowX: html.scrollWidth > html.clientWidth,
    ...(spec.widthIndependent === true ? { widthIndependent: true } : {}),
    ...(spec.alias === undefined ? {} : { alias: spec.alias }),
  };
  const problems = workflowQaFrameProblems(frame);
  if (problems.length > 0) {
    throw new WorkflowQaSelectorError(problems.map((entry) => entry.message).join("\n"));
  }
  if (CAPTURE) {
    const directory = framesDirectory();
    await page.elementLocator(element).screenshot({ path: `${directory}/${frame.file}` });
    await commands.writeFile(`${directory}/${name}.json`, `${JSON.stringify(frame, null, 2)}\n`);
  }
  return frame;
}

/** Renders `spec` across the matrix and returns the frames it recorded. */
export async function captureSurface(spec: SurfaceSpec): Promise<ReadonlyArray<WorkflowQaFrame>> {
  const original = { width: window.innerWidth, height: window.innerHeight };
  const themes = CAPTURE ? WORKFLOW_QA_THEMES : WORKFLOW_QA_THEMES.slice(0, 1);
  const viewports = CAPTURE ? WORKFLOW_QA_VIEWPORTS : WORKFLOW_QA_VIEWPORTS.slice(0, 1);
  const frames: Array<WorkflowQaFrame> = [];
  try {
    for (const theme of themes) {
      for (const viewport of viewports) {
        using _theme = applyTheme(theme);
        using _still = stillMotion();
        await page.viewport(viewport.width, viewport.height);
        // Only the clock is frozen: elapsed times are fixed, while timers still run.
        using _clock = fakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(WORKFLOW_QA_NOW);
        await using screen = await render(spec.element(), { router: spec.router ? "/" : false });
        await spec.settle?.(screen);
        if (spec.keepInteraction !== true) {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          await commands.resetPointer();
        }
        frames.push(await recordFrame(spec, screen, theme, viewport));
      }
    }
  } finally {
    await page.viewport(original.width, original.height);
  }
  return frames;
}

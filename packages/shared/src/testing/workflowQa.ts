/**
 * The frame matrix and the checks on it, shared by the workflow fixture browser tests (which
 * record frames) and `scripts/workflow-qa` (which collects, verifies and reports them). Frames are
 * plain data so a screenshot that matched nothing, or a surface missing a theme or width, fails
 * the same way wherever it is produced.
 */

import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  isUnconfiguredDefaultInstanceEnabled,
} from "@t3tools/contracts";

/**
 * The stock provider instances the app switches on when settings hold no entry for them, taken
 * from the contracts' own default-instance rule: one candidate per built-in driver, kept when
 * that rule enables it. A QA lane writes `enabled: false` for each, so none starts in the user's
 * default provider home.
 */
export function workflowQaDefaultEnabledStockInstances(): Array<{
  readonly id: string;
  readonly driver: string;
}> {
  return Object.keys(DEFAULT_MODEL_BY_PROVIDER).flatMap((driver) => {
    const id = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
    return isUnconfiguredDefaultInstanceEnabled(id) ? [{ id, driver }] : [];
  });
}

export const WORKFLOW_QA_THEMES = ["light", "dark"] as const;
export type WorkflowQaTheme = (typeof WORKFLOW_QA_THEMES)[number];

/** Desktop, the narrow right-panel breakpoint, and a phone width; every surface renders in all. */
export const WORKFLOW_QA_VIEWPORTS = [
  { width: 1300, height: 900 },
  { width: 736, height: 900 },
  { width: 400, height: 900 },
] as const;

/** What one saved screenshot records about itself, written beside the PNG as JSON. */
export interface WorkflowQaFrame {
  readonly surface: string;
  readonly state: string;
  readonly theme: WorkflowQaTheme;
  readonly width: number;
  readonly height: number;
  /** The component under test: the frame is only taken when this matched exactly one element. */
  readonly selector: string;
  /** Elements the selector matched; a frame with none was never captured. */
  readonly matchCount: number;
  /** What was photographed: the subject, or the backdrop the fixture paints around it. */
  readonly frameSelector: string;
  /** PNG file name, next to the frame's JSON. */
  readonly file: string;
  /** Size of the captured element in CSS pixels, measured at the matrix viewport (`height`). */
  readonly box: { readonly width: number; readonly height: number };
  /**
   * How the photograph was framed, recorded by the fixture harness. The matrix viewport is
   * `height` high; a subject that does not fit gets a taller viewport for the photograph alone,
   * because the iframe paints nothing below its own viewport. Absent for live frames, whose
   * browser captures the whole element itself.
   */
  readonly capture?: {
    /** Viewport height while the photograph was taken: `height`, or more for a tall subject. */
    readonly viewportHeight: number;
    /** The subject's top (page coordinates) and height, measured at that viewport. */
    readonly top: number;
    readonly height: number;
  };
  readonly htmlDark: boolean;
  readonly innerWidth: number;
  /** Whether the page scrolled sideways, which no surface should cause at these widths. */
  readonly pageOverflowX: boolean;
  /**
   * Set by surfaces whose box has a fixed width (a side panel, a sidebar row): their frames must
   * be pixel-identical at every viewport width, and the QA CLI checks that.
   */
  readonly widthIndependent?: boolean;
  /** Set when this state intentionally renders exactly like another state of the surface. */
  readonly alias?: { readonly of: string; readonly reason: string };
  /** SHA-256 of the PNG, added by the QA CLI when it collects the frame. */
  readonly pngSha256?: string;
}

const NAME_PART = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What a check found. The kind is what callers branch on; the message is for people. */
export type WorkflowQaProblemKind =
  | "no-frames"
  | "missing-state"
  | "unexpected-state"
  | "width-dependent"
  | "duplicate-state"
  | "stale-alias"
  | "bad-name"
  | "no-match"
  | "ambiguous-match"
  | "empty-box"
  | "wrong-theme"
  | "wrong-width"
  | "wrong-height"
  | "uncovered"
  | "layout-shift"
  | "blank-band"
  | "duplicate"
  | "missing"
  | "not-on-disk";

export interface WorkflowQaProblem {
  readonly kind: WorkflowQaProblemKind;
  readonly message: string;
}

const problem = (kind: WorkflowQaProblemKind, message: string): WorkflowQaProblem => ({
  kind,
  message,
});

const badNamePart = (frame: Pick<WorkflowQaFrame, "surface" | "state">): string | undefined =>
  [frame.surface, frame.state].find((part) => !NAME_PART.test(part));

/** The file stem for one frame; surface and state are lowercase words joined by hyphens. */
export function workflowQaFrameName(
  frame: Pick<WorkflowQaFrame, "surface" | "state" | "theme" | "width">,
): string {
  const bad = badNamePart(frame);
  if (bad !== undefined) {
    throw new Error(`Frame names use lowercase letters, digits and hyphens: "${bad}"`);
  }
  return `${frame.surface}__${frame.state}__${frame.theme}-${frame.width}`;
}

/** What is wrong with one frame on its own: it matched nothing, or the page was not as claimed. */
export function workflowQaFrameProblems(frame: WorkflowQaFrame): Array<WorkflowQaProblem> {
  const bad = badNamePart(frame);
  if (bad !== undefined) {
    return [problem("bad-name", `"${bad}" is not a lowercase hyphenated frame name part.`)];
  }
  const name = workflowQaFrameName(frame);
  const problems: Array<WorkflowQaProblem> = [];
  if (frame.matchCount < 1) {
    problems.push(problem("no-match", `${name}: selector "${frame.selector}" matched nothing.`));
  } else if (frame.matchCount > 1) {
    problems.push(
      problem(
        "ambiguous-match",
        `${name}: selector "${frame.selector}" matched ${frame.matchCount} elements, expected one.`,
      ),
    );
  }
  if (frame.box.width <= 0 || frame.box.height <= 0) {
    problems.push(problem("empty-box", `${name}: captured element has no size.`));
  }
  if (frame.htmlDark !== (frame.theme === "dark")) {
    problems.push(
      problem(
        "wrong-theme",
        `${name}: page was ${frame.htmlDark ? "dark" : "light"}, frame says ${frame.theme}.`,
      ),
    );
  }
  if (frame.innerWidth !== frame.width) {
    problems.push(
      problem(
        "wrong-width",
        `${name}: page was ${frame.innerWidth}px wide, frame says ${frame.width}px.`,
      ),
    );
  }
  // Height-sensitive layouts (vh units, height media queries) change when the viewport does.
  const matrix = WORKFLOW_QA_VIEWPORTS.find((viewport) => viewport.width === frame.width);
  if (matrix !== undefined && frame.height !== matrix.height) {
    problems.push(
      problem(
        "wrong-height",
        `${name}: viewport was ${frame.height}px high, the matrix is ${matrix.height}px.`,
      ),
    );
  }
  const { capture } = frame;
  if (capture !== undefined) {
    if (capture.viewportHeight < frame.height) {
      problems.push(
        problem(
          "wrong-height",
          `${name}: photographed in a ${capture.viewportHeight}px viewport, shorter than the matrix's ${frame.height}px.`,
        ),
      );
    }
    if (capture.top + capture.height > capture.viewportHeight + 1) {
      problems.push(
        problem(
          "uncovered",
          `${name}: the subject ends at ${capture.top + capture.height}px but the photograph's viewport is ${capture.viewportHeight}px high; the rest was never painted.`,
        ),
      );
    }
    if (Math.abs(capture.height - frame.box.height) > 1) {
      problems.push(
        problem(
          "layout-shift",
          `${name}: the subject was ${frame.box.height}px high at the matrix viewport and ${capture.height}px at the photograph's, so its layout depends on viewport height.`,
        ),
      );
    }
  }
  return problems;
}

/**
 * Everything wrong with a set of frames, empty when sound. Every surface state must appear once
 * in every theme and width, and each frame must be sound on its own.
 */
export function verifyWorkflowQaFrames(
  frames: ReadonlyArray<WorkflowQaFrame>,
): Array<WorkflowQaProblem> {
  const problems: Array<WorkflowQaProblem> = [];
  if (frames.length === 0) problems.push(problem("no-frames", "No frames were recorded."));
  const seen = new Map<string, number>();
  const groups = new Set<string>();
  for (const frame of frames) {
    problems.push(...workflowQaFrameProblems(frame));
    if (badNamePart(frame) !== undefined) continue;
    const name = workflowQaFrameName(frame);
    seen.set(name, (seen.get(name) ?? 0) + 1);
    groups.add(JSON.stringify([frame.surface, frame.state]));
  }
  for (const [name, count] of seen) {
    if (count > 1) problems.push(problem("duplicate", `${name}: recorded ${count} times.`));
  }
  for (const group of groups) {
    const [surface = "", state = ""] = JSON.parse(group) as Array<string>;
    for (const theme of WORKFLOW_QA_THEMES) {
      for (const { width } of WORKFLOW_QA_VIEWPORTS) {
        const name = workflowQaFrameName({ surface, state, theme, width });
        if (!seen.has(name)) problems.push(problem("missing", `${name}: missing.`));
      }
    }
  }
  return problems;
}

/** Run states every workflow surface shows. `retrying` is a node being retried, not a blocked review. */
export const WORKFLOW_QA_STATUSES = [
  "queued",
  "running",
  "passed",
  "failed",
  "stopped",
  "retrying",
] as const;

/** Data stress on top of the run states: nothing here may truncate away the state or break layout. */
export const WORKFLOW_QA_STRESS = [
  "long-labels",
  "missing-model",
  "many-nodes",
  "four-stage-running",
] as const;

/**
 * What the default sidebar row can report for a thread, named for the facts that produce it
 * (`resolveSidebarThreadStatus`), not for workflow outcomes the row never sees.
 */
export const WORKFLOW_QA_SIDEBAR_STATES = [
  "queued",
  "running",
  "waiting-idle",
  "waiting-on-thread",
  "turn-ended-workflow-running",
  "failed",
  "limited",
  "approval",
  "input",
  "done-unread",
  "long-title",
] as const;

export const WORKFLOW_QA_SETTINGS_STATES = [
  "populated",
  "empty",
  "long-labels",
  "missing-model",
  "read-only",
  "many-profiles",
] as const;

/**
 * The review card the coordinator's `graph_review` becomes: waiting for the person ("pending"),
 * with the decision on its way, then settled, or found out of date by the server. "large" is a
 * review of 400 tasks, more than its record lists, which keeps its buttons.
 */
export const WORKFLOW_QA_REVIEW_STATES = [
  "pending",
  "large",
  "approving",
  "approved",
  "dismissed",
  "stale",
] as const;

/** A graph surface's own extra state: the 150-node run scrolled to its running wave. */
export const WORKFLOW_QA_RUNNING_WAVE = "many-nodes-running-wave";
/** The Lineage Stop button only exists while hovered, so the hover is its own named state. */
export const WORKFLOW_QA_STOP_VISIBLE = "running-stop-visible";

const without = <T extends string>(states: ReadonlyArray<T>, ...removed: ReadonlyArray<string>) =>
  states.filter((state) => !removed.includes(state));

const GRAPH_STATES = [...WORKFLOW_QA_STATUSES, ...WORKFLOW_QA_STRESS] as ReadonlyArray<string>;
export const WORKFLOW_QA_AGENT_COUNTS = [4, 40, 256] as const;
const OVERVIEW_STATES = WORKFLOW_QA_AGENT_COUNTS.map((count) => `agents-${count}`);
// A script declares no dependencies, so nothing can be retrying behind another node.
const SCRIPT_STATES = without(GRAPH_STATES, "retrying", "missing-model");
// A collapsed Lineage row shows the run's status and title only.
const COLLAPSED_GRAPH_STATES = ["running", "passed", "failed", "stopped", "long-labels"];
const COLLAPSED_SCRIPT_STATES = COLLAPSED_GRAPH_STATES;
// The narrow panel shows the states most likely to overflow a row.
const NARROW_LINEAGE_STATES = ["running", "failed", "long-labels"];

/**
 * Every surface and state the fixtures must record. Adding a surface or state means adding it
 * here, so a fixture that is deleted or skipped fails the capture instead of shrinking it.
 */
export const WORKFLOW_QA_EXPECTED_STATES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "workflow-block-graph": [...GRAPH_STATES, WORKFLOW_QA_RUNNING_WAVE, ...OVERVIEW_STATES],
  "workflow-block-script": [...SCRIPT_STATES, ...OVERVIEW_STATES],
  "workflow-canvas": [...GRAPH_STATES, WORKFLOW_QA_RUNNING_WAVE],
  "workflow-model-identities": ["overview", "graph", "graph-fallbacks"],
  "lineage-row-graph": [...GRAPH_STATES, WORKFLOW_QA_STOP_VISIBLE],
  "lineage-row-script": SCRIPT_STATES,
  "lineage-row-narrow-graph": NARROW_LINEAGE_STATES,
  "lineage-row-narrow-script": NARROW_LINEAGE_STATES,
  "lineage-collapsed-graph": COLLAPSED_GRAPH_STATES,
  "lineage-collapsed-script": COLLAPSED_SCRIPT_STATES,
  "sidebar-status": WORKFLOW_QA_SIDEBAR_STATES,
  "settings-agents": WORKFLOW_QA_SETTINGS_STATES,
  "workflow-review": WORKFLOW_QA_REVIEW_STATES,
};

/** States a surface deliberately has no frame for, with why. They are listed in every manifest. */
export const WORKFLOW_QA_OMITTED_STATES: ReadonlyArray<{
  readonly surface: string;
  readonly state: string;
  readonly reason: string;
}> = [
  ...["retrying", "missing-model"].flatMap((state) =>
    ["workflow-block-script", "lineage-row-script"].map((surface) => ({
      surface,
      state,
      reason:
        state === "retrying"
          ? "A script declares no dependencies, so no node waits behind a retrying one."
          : "A script's rows show no model, so a missing model changes nothing visible.",
    })),
  ),
  ...["queued", "retrying", "missing-model", "many-nodes"].flatMap((state) =>
    ["lineage-collapsed-graph", "lineage-collapsed-script"].map((surface) => ({
      surface,
      state,
      reason: "A collapsed row shows only the run status and title; this renders as running.",
    })),
  ),
];

/** How much a set of frames covers, in numbers a report can quote. */
export interface WorkflowQaCoverage {
  readonly surfaces: number;
  readonly states: number;
  readonly frames: number;
  readonly expectedSurfaces: number;
  readonly expectedStates: number;
  readonly omitted: number;
}

export function workflowQaCoverage(frames: ReadonlyArray<WorkflowQaFrame>): WorkflowQaCoverage {
  const states = new Set(frames.map((frame) => `${frame.surface}__${frame.state}`));
  return {
    surfaces: new Set(frames.map((frame) => frame.surface)).size,
    states: states.size,
    frames: frames.length,
    expectedSurfaces: Object.keys(WORKFLOW_QA_EXPECTED_STATES).length,
    expectedStates: Object.values(WORKFLOW_QA_EXPECTED_STATES).reduce(
      (total, list) => total + list.length,
      0,
    ),
    omitted: WORKFLOW_QA_OMITTED_STATES.length,
  };
}

/** Expected states with no frames, and recorded states nobody listed as expected. */
export function verifyWorkflowQaCoverage(
  frames: ReadonlyArray<WorkflowQaFrame>,
): Array<WorkflowQaProblem> {
  const recorded = new Map<string, Set<string>>();
  for (const frame of frames) {
    const states = recorded.get(frame.surface) ?? new Set<string>();
    states.add(frame.state);
    recorded.set(frame.surface, states);
  }
  const problems: Array<WorkflowQaProblem> = [];
  for (const [surface, expected] of Object.entries(WORKFLOW_QA_EXPECTED_STATES)) {
    for (const state of expected) {
      if (!recorded.get(surface)?.has(state)) {
        problems.push(problem("missing-state", `${surface}__${state}: expected, no frames.`));
      }
    }
  }
  for (const [surface, states] of recorded) {
    const expected = WORKFLOW_QA_EXPECTED_STATES[surface];
    for (const state of states) {
      if (expected === undefined || !expected.includes(state)) {
        problems.push(
          problem(
            "unexpected-state",
            `${surface}__${state}: recorded but not listed in WORKFLOW_QA_EXPECTED_STATES.`,
          ),
        );
      }
    }
  }
  return problems;
}

/**
 * Checks that need the pixels, run on frames that carry `pngSha256`: a fixed-width surface must
 * look the same at every viewport width, and two states of one surface must not render alike
 * unless one declares itself an alias of the other (and then they must really match).
 */
export function verifyWorkflowQaImages(
  frames: ReadonlyArray<WorkflowQaFrame>,
): Array<WorkflowQaProblem> {
  const problems: Array<WorkflowQaProblem> = [];
  const hashed = frames.filter((frame) => frame.pngSha256 !== undefined);
  const byState = new Map<string, Array<WorkflowQaFrame>>();
  for (const frame of hashed) {
    const key = JSON.stringify([frame.surface, frame.state]);
    byState.set(key, [...(byState.get(key) ?? []), frame]);
  }
  for (const group of byState.values()) {
    const first = group[0]!;
    if (first.widthIndependent === true) {
      for (const theme of WORKFLOW_QA_THEMES) {
        const hashes = new Set(
          group.filter((frame) => frame.theme === theme).map((frame) => frame.pngSha256),
        );
        if (hashes.size > 1) {
          problems.push(
            problem(
              "width-dependent",
              `${first.surface}__${first.state}__${theme}: ${hashes.size} different images across widths, expected one.`,
            ),
          );
        }
      }
    }
  }
  const signature = (group: ReadonlyArray<WorkflowQaFrame>) =>
    group
      .map((frame) => `${frame.theme}-${frame.width}:${frame.pngSha256}`)
      .sort()
      .join(",");
  const bySurface = new Map<string, Array<ReadonlyArray<WorkflowQaFrame>>>();
  for (const group of byState.values()) {
    const surface = group[0]!.surface;
    bySurface.set(surface, [...(bySurface.get(surface) ?? []), group]);
  }
  for (const [surface, groups] of bySurface) {
    const alike = new Map<string, Array<ReadonlyArray<WorkflowQaFrame>>>();
    for (const group of groups) {
      alike.set(signature(group), [...(alike.get(signature(group)) ?? []), group]);
    }
    for (const same of alike.values()) {
      if (same.length < 2) continue;
      const states = same.map((group) => group[0]!.state);
      // The states that claim to be aliases must all point at a state in this identical set.
      const unexplained = same.filter((group) => {
        const alias = group[0]!.alias;
        return alias !== undefined && !states.includes(alias.of);
      });
      const plain = same.filter((group) => group[0]!.alias === undefined);
      if (plain.length > 1 || unexplained.length > 0) {
        problems.push(
          problem(
            "duplicate-state",
            `${surface}: states ${states.join(", ")} render identically in every frame and are not declared aliases of one another.`,
          ),
        );
      }
    }
    for (const group of groups) {
      const alias = group[0]!.alias;
      if (alias === undefined) continue;
      const target = groups.find((other) => other[0]!.state === alias.of);
      if (target === undefined || signature(target) !== signature(group)) {
        problems.push(
          problem(
            "stale-alias",
            `${surface}__${group[0]!.state}: declared an alias of ${alias.of} but renders differently or the target is missing.`,
          ),
        );
      }
    }
  }
  return problems;
}

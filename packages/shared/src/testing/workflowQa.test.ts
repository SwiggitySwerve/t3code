import { describe, expect, it } from "vite-plus/test";

import {
  WORKFLOW_QA_EXPECTED_STATES,
  WORKFLOW_QA_OMITTED_STATES,
  WORKFLOW_QA_THEMES,
  WORKFLOW_QA_VIEWPORTS,
  verifyWorkflowQaCoverage,
  verifyWorkflowQaFrames,
  verifyWorkflowQaImages,
  workflowQaCoverage,
  workflowQaDefaultEnabledStockInstances,
  workflowQaFrameName,
  type WorkflowQaFrame,
} from "./workflowQa.ts";

function frame(
  surface: string,
  state: string,
  theme: WorkflowQaFrame["theme"],
  width: number,
  overrides: Partial<WorkflowQaFrame> = {},
): WorkflowQaFrame {
  const base = { surface, state, theme, width };
  return {
    ...base,
    height: 900,
    selector: "[data-workflow-opening]",
    matchCount: 1,
    frameSelector: "[data-workflow-opening]",
    file: `${workflowQaFrameName(base)}.png`,
    box: { width: 600, height: 300 },
    htmlDark: theme === "dark",
    innerWidth: width,
    pageOverflowX: false,
    ...overrides,
  };
}

const fullSet = (surface: string, state: string) =>
  WORKFLOW_QA_THEMES.flatMap((theme) =>
    WORKFLOW_QA_VIEWPORTS.map(({ width }) => frame(surface, state, theme, width)),
  );

const kinds = (frames: ReadonlyArray<WorkflowQaFrame>) =>
  verifyWorkflowQaFrames(frames).map((problem) => problem.kind);
const messages = (frames: ReadonlyArray<WorkflowQaFrame>) =>
  verifyWorkflowQaFrames(frames).map((problem) => problem.message);

describe("workflow QA frames", () => {
  it("accepts a state captured in every theme and width", () => {
    expect(verifyWorkflowQaFrames(fullSet("workflow-block-graph", "running"))).toEqual([]);
  });

  it("fails a frame whose selector matched nothing", () => {
    const frames = fullSet("workflow-block-graph", "running");
    frames[0] = { ...frames[0]!, matchCount: 0 };
    expect(kinds(frames)).toEqual(["no-match"]);
    expect(messages(frames)).toEqual([
      expect.stringContaining('selector "[data-workflow-opening]" matched nothing'),
    ]);
  });

  it("fails a frame whose selector matched more than one element", () => {
    const frames = fullSet("workflow-block-graph", "running");
    frames[0] = { ...frames[0]!, matchCount: 2 };
    expect(kinds(frames)).toEqual(["ambiguous-match"]);
  });

  it("reports a sidecar with an unusable name instead of throwing", () => {
    const frames = fullSet("workflow-block-graph", "running");
    frames.push({ ...frames[0]!, surface: "Workflow Block" });
    expect(kinds(frames)).toEqual(["bad-name"]);
  });

  it("fails a frame taken in a viewport that was resized", () => {
    const frames = fullSet("workflow-block-graph", "running");
    frames[2] = { ...frames[2]!, height: 4_200 };
    expect(kinds(frames)).toEqual(["wrong-height"]);
    expect(messages(frames)).toEqual([expect.stringContaining("4200px high, the matrix is 900px")]);
  });

  it("accepts a tall subject photographed in a viewport as high as itself", () => {
    const frames = fullSet("workflow-block-script", "many-nodes").map((entry) => ({
      ...entry,
      box: { width: 600, height: 7_398 },
      capture: { viewportHeight: 7_422, top: 24, height: 7_398 },
    }));
    expect(verifyWorkflowQaFrames(frames)).toEqual([]);
  });

  it("fails a photograph whose viewport ends before the subject does", () => {
    const frames = fullSet("workflow-block-script", "many-nodes");
    frames[0] = {
      ...frames[0]!,
      box: { width: 600, height: 7_398 },
      capture: { viewportHeight: 900, top: 24, height: 7_398 },
    };
    expect(kinds(frames)).toEqual(["uncovered"]);
    expect(messages(frames)).toEqual([expect.stringContaining("ends at 7422px")]);
  });

  it("fails a subject whose height changes with the viewport", () => {
    const frames = fullSet("workflow-block-script", "many-nodes");
    frames[0] = {
      ...frames[0]!,
      box: { width: 600, height: 1_200 },
      capture: { viewportHeight: 2_000, top: 0, height: 1_800 },
    };
    expect(kinds(frames)).toEqual(["layout-shift"]);
  });

  it("fails a photograph taken in a viewport shorter than the matrix's", () => {
    const frames = fullSet("workflow-block-script", "many-nodes");
    frames[0] = { ...frames[0]!, capture: { viewportHeight: 700, top: 0, height: 300 } };
    expect(kinds(frames)).toEqual(["wrong-height"]);
  });

  it("fails when a theme or width is missing", () => {
    const frames = fullSet("lineage-row-graph", "failed").filter(
      (entry) => !(entry.theme === "dark" && entry.width === 400),
    );
    expect(verifyWorkflowQaFrames(frames)).toEqual([
      { kind: "missing", message: "lineage-row-graph__failed__dark-400: missing." },
    ]);
  });

  it("fails a frame taken in the wrong theme or at the wrong width", () => {
    const frames = fullSet("sidebar-status", "queued");
    frames[0] = { ...frames[0]!, htmlDark: true };
    frames[1] = { ...frames[1]!, innerWidth: 500 };
    expect(kinds(frames)).toEqual(["wrong-theme", "wrong-width"]);
    expect(messages(frames)).toEqual([
      expect.stringContaining("page was dark, frame says light"),
      expect.stringContaining("page was 500px wide, frame says 736px"),
    ]);
  });

  it("fails a frame recorded twice, an empty element and an empty run", () => {
    const frames = fullSet("settings-agents", "empty");
    expect(kinds([...frames, frames[0]!, { ...frames[1]!, box: { width: 0, height: 4 } }])).toEqual(
      ["empty-box", "duplicate", "duplicate"],
    );
    expect(kinds([])).toEqual(["no-frames"]);
  });

  it("rejects names that would not make a safe file name", () => {
    expect(() =>
      workflowQaFrameName({
        surface: "Workflow Block",
        state: "running",
        theme: "light",
        width: 400,
      }),
    ).toThrow(/lowercase letters/);
  });
});

const hashed = (
  frames: ReadonlyArray<WorkflowQaFrame>,
  hash: (frame: WorkflowQaFrame) => string,
): Array<WorkflowQaFrame> => frames.map((entry) => ({ ...entry, pngSha256: hash(entry) }));

describe("workflow QA image checks", () => {
  const imageKinds = (frames: ReadonlyArray<WorkflowQaFrame>) =>
    verifyWorkflowQaImages(frames).map((problem) => problem.kind);
  const pair = (
    surface: string,
    one: string,
    other: string,
    overrides: Partial<WorkflowQaFrame> = {},
  ) => [
    ...fullSet(surface, one).map((entry) => ({ ...entry, ...overrides })),
    ...fullSet(surface, other).map((entry) => ({ ...entry, ...overrides })),
  ];

  it("accepts states that look different", () => {
    const frames = hashed(
      pair("sidebar-status", "queued", "running"),
      (entry) => `${entry.state}-${entry.theme}-${entry.width}`,
    );
    expect(verifyWorkflowQaImages(frames)).toEqual([]);
  });

  it("fails two states of a surface that render alike in every frame", () => {
    const frames = hashed(
      pair("workflow-block-script", "running", "missing-model"),
      (entry) => `${entry.theme}-${entry.width}`,
    );
    expect(imageKinds(frames)).toEqual(["duplicate-state"]);
  });

  it("allows an intentional alias, and fails it once it stops matching", () => {
    const alias = { of: "waiting-idle", reason: "U9 owns the difference." };
    const same = pair("sidebar-status", "waiting-idle", "turn-ended").map((entry) =>
      entry.state === "turn-ended" ? { ...entry, alias } : entry,
    );
    expect(imageKinds(hashed(same, (entry) => `${entry.theme}-${entry.width}`))).toEqual([]);
    expect(
      imageKinds(hashed(same, (entry) => `${entry.state}-${entry.theme}-${entry.width}`)),
    ).toEqual(["stale-alias"]);
  });

  it("fails a fixed-width surface that differs across widths", () => {
    const frames = hashed(
      fullSet("lineage-row-graph", "running").map((entry) => ({
        ...entry,
        widthIndependent: true,
      })),
      (entry) => `${entry.theme}-${entry.width}`,
    );
    // Light and dark may differ; the three widths of one theme may not.
    expect(imageKinds(frames)).toEqual(["width-dependent", "width-dependent"]);
    expect(imageKinds(hashed(frames, (entry) => entry.theme))).toEqual([]);
  });
});

describe("workflow QA coverage", () => {
  const everything = () =>
    Object.entries(WORKFLOW_QA_EXPECTED_STATES).flatMap(([surface, states]) =>
      states.flatMap((state) => fullSet(surface, state)),
    );

  it("accepts every expected state and counts them", () => {
    expect(verifyWorkflowQaCoverage(everything())).toEqual([]);
    const coverage = workflowQaCoverage(everything());
    expect(coverage.surfaces).toBe(coverage.expectedSurfaces);
    expect(coverage.states).toBe(coverage.expectedStates);
    expect(coverage.frames).toBe(coverage.expectedStates * 6);
    expect(coverage.omitted).toBe(WORKFLOW_QA_OMITTED_STATES.length);
  });

  it("fails a deleted fixture and a state nobody listed", () => {
    const frames = everything().filter(
      (entry) => !(entry.surface === "settings-agents" && entry.state === "empty"),
    );
    expect(verifyWorkflowQaCoverage(frames).map((problem) => problem.kind)).toEqual([
      "missing-state",
    ]);
    expect(
      verifyWorkflowQaCoverage([...everything(), ...fullSet("settings-agents", "surprise")]).map(
        (problem) => problem.kind,
      ),
    ).toEqual(["unexpected-state"]);
  });

  it("never lists a state as both expected and omitted", () => {
    for (const { surface, state } of WORKFLOW_QA_OMITTED_STATES) {
      expect(WORKFLOW_QA_EXPECTED_STATES[surface]).not.toContain(state);
    }
  });
});

describe("stock provider instances", () => {
  it("lists the instances the contracts' default rule enables", () => {
    expect(workflowQaDefaultEnabledStockInstances()).toEqual([
      { id: "codex", driver: "codex" },
      { id: "claudeAgent", driver: "claudeAgent" },
    ]);
  });
});

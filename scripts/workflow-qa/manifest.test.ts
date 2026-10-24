// @effect-diagnostics nodeBuiltinImport:off - the tests build real folders and git repositories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  WORKFLOW_QA_THEMES,
  WORKFLOW_QA_VIEWPORTS,
  workflowQaFrameName,
  type WorkflowQaFrame,
} from "@t3tools/shared/testing/workflowQa";
import { PNG } from "pngjs";
import { expect, it } from "vite-plus/test";

import { compareManifests, findProblems, readFrames, renderManifestMarkdown } from "./manifest.ts";

function frames(): Array<WorkflowQaFrame> {
  return WORKFLOW_QA_THEMES.flatMap((theme) =>
    WORKFLOW_QA_VIEWPORTS.map(({ width }) => {
      const base = { surface: "workflow-canvas", state: "many-nodes", theme, width };
      return {
        ...base,
        height: 900,
        selector: "[data-workflow-waves]",
        matchCount: 1,
        frameSelector: "[data-qa-column]",
        file: `${workflowQaFrameName(base)}.png`,
        box: { width, height: 480 },
        htmlDark: theme === "dark",
        innerWidth: width,
        pageOverflowX: false,
      };
    }),
  );
}

it("reads sidecars back and reports a PNG that is not on disk", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-qa-manifest-"));
  try {
    const written = frames();
    for (const frame of written) {
      NodeFS.writeFileSync(
        NodePath.join(directory, frame.file.replace(".png", ".json")),
        JSON.stringify(frame),
      );
      if (frame.theme === "light") {
        NodeFS.writeFileSync(
          NodePath.join(directory, frame.file),
          PNG.sync.write(new PNG({ width: frame.box.width, height: frame.box.height })),
        );
      }
    }
    const read = readFrames(directory);
    expect(read).toHaveLength(6);
    expect(findProblems(read, directory).map((problem) => problem.message)).toEqual(
      WORKFLOW_QA_VIEWPORTS.map(
        ({ width }) =>
          `workflow-canvas__many-nodes__dark-${width}: workflow-canvas__many-nodes__dark-${width}.png is not on disk.`,
      ).sort(),
    );
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("lists problems ahead of the frame table", () => {
  const markdown = renderManifestMarkdown({
    kind: "fixtures",
    createdAt: "2026-10-24T12:00:00.000Z",
    repo: { head: "abc1234567", branch: "feat/x", dirtyFiles: 2, tree: "0123456789ab" },
    tool: { head: "def7654321", branch: "main", dirtyFiles: 0, tree: "ba9876543210" },
    command: "vp test run",
    frames: frames().slice(0, 1),
    problems: ["workflow-canvas__many-nodes__light-400: missing."],
    coverage: null,
    omitted: [],
  });
  expect(markdown).toContain("feat/x @ abc1234567, 2 uncommitted files, tree 0123456789ab");
  expect(markdown).toContain("Tool: main @ def7654321");
  expect(markdown).toContain("Coverage: not checked");
  expect(markdown.indexOf("## Problems")).toBeLessThan(markdown.indexOf("| Surface |"));
  expect(markdown).toContain(
    "| workflow-canvas | many-nodes | light | 1300 | 900 | n/a | 1300x480 | no |",
  );
});

it("compares two captures by frame name and image hash", () => {
  const baseline = { frames: frames().map((frame) => ({ ...frame, pngSha256: "a" })) };
  const current = {
    frames: frames()
      .filter((frame) => !(frame.theme === "dark" && frame.width === 1300))
      .map((frame) => ({
        ...frame,
        pngSha256: frame.theme === "light" && frame.width === 400 ? "b" : "a",
      })),
  };
  expect(compareManifests(baseline, current)).toEqual({
    same: 4,
    changed: ["workflow-canvas__many-nodes__light-400"],
    added: [],
    removed: ["workflow-canvas__many-nodes__dark-1300"],
  });
  expect(compareManifests(current, baseline).added).toEqual([
    "workflow-canvas__many-nodes__dark-1300",
  ]);
});

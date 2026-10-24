// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - hand-run CLI tooling, outside any Effect runtime.
// What a QA run leaves behind: the frames, what code produced them, and every problem found.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  WORKFLOW_QA_OMITTED_STATES,
  verifyWorkflowQaCoverage,
  verifyWorkflowQaFrames,
  verifyWorkflowQaImages,
  workflowQaCoverage,
  workflowQaFrameName,
  type WorkflowQaCoverage,
  type WorkflowQaFrame,
  type WorkflowQaProblem,
} from "@t3tools/shared/testing/workflowQa";

import { framePixelProblems } from "./pixels.ts";
import { workingTreeId } from "./snapshot.ts";
import { git } from "./util.ts";

export interface RepoFingerprint {
  readonly head: string;
  readonly branch: string | null;
  /** Changed and untracked files; a clean tree is 0. */
  readonly dirtyFiles: number;
  /**
   * The git tree of every tracked and unignored untracked file, so two runs on the same
   * uncommitted code share a fingerprint and an untracked file changes it.
   */
  readonly tree: string;
}

export interface QaManifest {
  readonly kind: "fixtures" | "live";
  readonly createdAt: string;
  /** The code that was photographed. */
  readonly repo: RepoFingerprint;
  /** The checkout whose scripts produced this manifest, which can differ from `repo`. */
  readonly tool: RepoFingerprint;
  readonly command: string;
  /** What the frames cover; null when the run was filtered or live, where coverage is not checked. */
  readonly coverage: WorkflowQaCoverage | null;
  /** States deliberately without frames, each with its reason. */
  readonly omitted: typeof WORKFLOW_QA_OMITTED_STATES;
  readonly frames: ReadonlyArray<WorkflowQaFrame>;
  /** Empty when every check passed. */
  readonly problems: ReadonlyArray<string>;
}

export function repoFingerprint(repo: string): RepoFingerprint {
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  return {
    head: git(repo, ["rev-parse", "--short=10", "HEAD"]).trim(),
    branch: branch === "HEAD" ? null : branch,
    dirtyFiles: git(repo, ["status", "--porcelain"]).split("\n").filter(Boolean).length,
    tree: workingTreeId(repo).slice(0, 12),
  };
}

/** Every frame sidecar in `directory`, in file-name order, with the hash of its PNG when present. */
export function readFrames(directory: string): Array<WorkflowQaFrame> {
  if (!NodeFS.existsSync(directory)) return [];
  return NodeFS.readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .sort()
    .map((name): WorkflowQaFrame => {
      const frame: WorkflowQaFrame = JSON.parse(
        NodeFS.readFileSync(NodePath.join(directory, name), "utf8"),
      );
      const png = NodePath.join(directory, frame.file);
      return NodeFS.existsSync(png)
        ? {
            ...frame,
            pngSha256: NodeCrypto.createHash("sha256")
              .update(NodeFS.readFileSync(png))
              .digest("hex"),
          }
        : frame;
    });
}

/**
 * Frame problems, image problems (fixed-width surfaces that differ across widths, states that
 * render alike), any PNG a sidecar names that is not on disk, any PNG that does not cover its
 * subject or goes blank below the viewport and, when `coverage` is set, every
 * expected state with no frame.
 */
export function findProblems(
  frames: ReadonlyArray<WorkflowQaFrame>,
  directory: string,
  options: { readonly coverage: boolean } = { coverage: false },
): Array<WorkflowQaProblem> {
  const problems = [
    ...verifyWorkflowQaFrames(frames),
    ...verifyWorkflowQaImages(frames),
    ...(options.coverage ? verifyWorkflowQaCoverage(frames) : []),
  ];
  for (const frame of frames) {
    if (!NodeFS.existsSync(NodePath.join(directory, frame.file))) {
      problems.push({
        kind: "not-on-disk",
        message: `${workflowQaFrameName(frame)}: ${frame.file} is not on disk.`,
      });
    } else {
      problems.push(...framePixelProblems(frame, directory));
    }
  }
  return problems;
}

/** The coverage and omitted-state fields of a manifest for a run that checked `coverage`, or not. */
export function coverageFields(
  frames: ReadonlyArray<WorkflowQaFrame>,
  checked: boolean,
): Pick<QaManifest, "coverage" | "omitted"> {
  return {
    coverage: checked ? workflowQaCoverage(frames) : null,
    omitted: checked ? WORKFLOW_QA_OMITTED_STATES : [],
  };
}

export function renderManifestMarkdown(manifest: QaManifest): string {
  const { repo, tool } = manifest;
  const { coverage } = manifest;
  const lines = [
    `# Workflow QA frames (${manifest.kind})`,
    "",
    `- Created: ${manifest.createdAt}`,
    `- Code photographed: ${repo.branch ?? "detached"} @ ${repo.head}, ${repo.dirtyFiles} uncommitted files, tree ${repo.tree}`,
    `- Tool: ${tool.branch ?? "detached"} @ ${tool.head}, ${tool.dirtyFiles} uncommitted files, tree ${tool.tree}`,
    `- Command: \`${manifest.command}\``,
    `- Frames: ${manifest.frames.length}; problems: ${manifest.problems.length}`,
    coverage === null
      ? "- Coverage: not checked (a filtered or live run)"
      : `- Coverage: ${coverage.surfaces}/${coverage.expectedSurfaces} surfaces, ${coverage.states}/${coverage.expectedStates} states, ${coverage.frames} frames; ${coverage.omitted} states omitted on purpose`,
    "",
  ];
  if (manifest.omitted.length > 0) {
    lines.push(
      "## States without frames, on purpose",
      "",
      ...manifest.omitted.map((entry) => `- ${entry.surface} / ${entry.state}: ${entry.reason}`),
      "",
    );
  }
  const aliases = manifest.frames.filter(
    (frame) => frame.alias !== undefined && frame.theme === "light" && frame.width === 1300,
  );
  if (aliases.length > 0) {
    lines.push(
      "## Intentional aliases",
      "",
      ...aliases.map(
        (frame) =>
          `- ${frame.surface} / ${frame.state} = ${frame.alias?.of}: ${frame.alias?.reason}`,
      ),
      "",
    );
  }
  if (manifest.problems.length > 0) {
    lines.push("## Problems", "", ...manifest.problems.map((problem) => `- ${problem}`), "");
  }
  lines.push(
    "| Surface | State | Theme | Width | Layout viewport | Capture viewport | Element | Overflow-x | File |",
    "|---|---|---|---|---|---|---|---|---|",
    ...manifest.frames.map(
      (frame) =>
        `| ${frame.surface} | ${frame.state} | ${frame.theme} | ${frame.width} | ${frame.height} | ${frame.capture?.viewportHeight ?? "n/a"} | ${frame.box.width}x${frame.box.height} | ${frame.pageOverflowX ? "yes" : "no"} | ${frame.file} |`,
    ),
    "",
  );
  return lines.join("\n");
}

export interface ManifestComparison {
  readonly same: number;
  readonly changed: ReadonlyArray<string>;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

/** Frames of a current manifest against a baseline, by frame name and PNG hash. */
export function compareManifests(
  baseline: Pick<QaManifest, "frames">,
  current: Pick<QaManifest, "frames">,
): ManifestComparison {
  const hashes = (manifest: Pick<QaManifest, "frames">) =>
    new Map(manifest.frames.map((frame) => [workflowQaFrameName(frame), frame.pngSha256] as const));
  const before = hashes(baseline);
  const after = hashes(current);
  const changed: Array<string> = [];
  let same = 0;
  for (const [name, hash] of after) {
    if (!before.has(name)) continue;
    if (before.get(name) === hash) same += 1;
    else changed.push(name);
  }
  return {
    same,
    changed,
    added: [...after.keys()].filter((name) => !before.has(name)),
    removed: [...before.keys()].filter((name) => !after.has(name)),
  };
}

export function readManifest(directory: string): QaManifest {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(directory, "manifest.json"), "utf8"));
}

export function writeManifest(directory: string, manifest: QaManifest): void {
  NodeFS.writeFileSync(
    NodePath.join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(directory, "manifest.md"), renderManifestMarkdown(manifest));
}

// @effect-diagnostics nodeBuiltinImport:off - hand-run CLI tooling, outside any Effect runtime.
// Checks on a frame's PNG itself: the picture must cover the whole subject, and must not go blank
// below the viewport it was taken in. These are the two ways a screenshot of an element taller
// than its viewport fails without any error.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { WorkflowQaFrame, WorkflowQaProblem } from "@t3tools/shared/testing/workflowQa";
import { workflowQaFrameName } from "@t3tools/shared/testing/workflowQa";
import { PNG } from "pngjs";

/** The shortest flat tail, in CSS pixels, taken for an unpainted region rather than empty space. */
const MIN_BLANK_BAND = 100;

const problem = (kind: WorkflowQaProblem["kind"], message: string): WorkflowQaProblem => ({
  kind,
  message,
});

/**
 * What is wrong with the picture of one frame; empty when it covers its subject. A missing PNG is
 * reported elsewhere (`not-on-disk`) and skipped here.
 *
 * - `uncovered`: the picture is shorter than the subject, so part of it was never photographed.
 * - `blank-band`: everything below the matrix viewport is one flat colour. A subject taller than
 *   the viewport it was photographed in comes out this way, because nothing past the viewport is
 *   painted. Rows above the viewport may be flat legitimately; rows below it never should be.
 */
export function framePixelProblems(
  frame: WorkflowQaFrame,
  directory: string,
): Array<WorkflowQaProblem> {
  const path = NodePath.join(directory, frame.file);
  if (!NodeFS.existsSync(path)) return [];
  const name = workflowQaFrameName(frame);
  let image: PNG;
  try {
    image = PNG.sync.read(NodeFS.readFileSync(path));
  } catch (error) {
    return [
      problem("uncovered", `${name}: ${frame.file} is not a readable PNG (${String(error)}).`),
    ];
  }
  const scale = frame.box.width > 0 ? image.width / frame.box.width : 1;
  const expectedHeight = frame.box.height * scale;
  if (Math.abs(image.height - expectedHeight) > 2 * scale) {
    return [
      problem(
        "uncovered",
        `${name}: the picture is ${image.height}px high but the subject is ${frame.box.height}px (x${scale.toFixed(2)}); part of it was not photographed.`,
      ),
    ];
  }
  // Rows from the matrix viewport's bottom edge down; the subject starts `top` px into the page.
  const first = Math.max(0, Math.round((frame.height - (frame.capture?.top ?? 0)) * scale));
  const band = image.height - first;
  if (band < MIN_BLANK_BAND * scale) return [];
  const row = (y: number) => image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4);
  const reference = row(first).subarray(0, 4);
  for (let y = first; y < image.height; y += 1) {
    const pixels = row(y);
    for (let x = 0; x < pixels.length; x += 4) {
      if (
        pixels[x] !== reference[0] ||
        pixels[x + 1] !== reference[1] ||
        pixels[x + 2] !== reference[2] ||
        pixels[x + 3] !== reference[3]
      ) {
        return [];
      }
    }
  }
  return [
    problem(
      "blank-band",
      `${name}: every row from ${first}px down to the bottom (${band}px) is one flat colour; the part of the subject below the viewport was not painted.`,
    ),
  ];
}

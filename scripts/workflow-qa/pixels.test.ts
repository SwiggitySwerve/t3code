// @effect-diagnostics nodeBuiltinImport:off - the tests write real PNG files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { WorkflowQaFrame } from "@t3tools/shared/testing/workflowQa";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { framePixelProblems } from "./pixels.ts";

const scratch: Array<string> = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const WIDTH = 8;

/** A white picture of `rows` rows whose first `painted` rows hold a non-white pattern. */
function writePicture(rows: number, painted: number): { directory: string; file: string } {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-qa-pixels-"));
  scratch.push(directory);
  const image = new PNG({ width: WIDTH, height: rows });
  image.data.fill(255);
  for (let y = 0; y < painted; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * 4;
      image.data[at] = (x * 31 + y * 7) % 200;
      image.data[at + 1] = (x * 17 + y * 3) % 200;
    }
  }
  const file = "workflow-block-script__many-nodes__light-400.png";
  NodeFS.writeFileSync(NodePath.join(directory, file), PNG.sync.write(image));
  return { directory, file };
}

const frame = (file: string, boxHeight: number, overrides: Partial<WorkflowQaFrame> = {}) =>
  ({
    surface: "workflow-block-script",
    state: "many-nodes",
    theme: "light",
    width: 400,
    height: 900,
    selector: "[data-workflow-opening]",
    matchCount: 1,
    frameSelector: "[data-workflow-opening]",
    file,
    box: { width: WIDTH, height: boxHeight },
    htmlDark: false,
    innerWidth: 400,
    pageOverflowX: false,
    ...overrides,
  }) satisfies WorkflowQaFrame;

describe("frame picture checks", () => {
  it("accepts a tall picture painted all the way down", () => {
    const { directory, file } = writePicture(2_000, 2_000);
    expect(framePixelProblems(frame(file, 2_000), directory)).toEqual([]);
  });

  it("rejects a tall picture that is blank below the viewport", () => {
    const { directory, file } = writePicture(2_000, 900);
    const problems = framePixelProblems(frame(file, 2_000), directory);
    expect(problems.map((entry) => entry.kind)).toEqual(["blank-band"]);
    expect(problems[0]?.message).toContain("every row from 900px");
  });

  it("measures the viewport from where the subject starts on the page", () => {
    // The subject starts 24px down, so only its rows from 876 on lie below the viewport.
    const { directory, file } = writePicture(2_000, 876);
    const tall = frame(file, 2_000, { capture: { viewportHeight: 2_024, top: 24, height: 2_000 } });
    expect(framePixelProblems(tall, directory).map((entry) => entry.kind)).toEqual(["blank-band"]);
  });

  it("leaves a short subject alone, even when it ends in empty space", () => {
    const { directory, file } = writePicture(600, 100);
    expect(framePixelProblems(frame(file, 600), directory)).toEqual([]);
  });

  it("rejects a picture shorter than its subject", () => {
    const { directory, file } = writePicture(900, 900);
    const problems = framePixelProblems(frame(file, 2_000), directory);
    expect(problems.map((entry) => entry.kind)).toEqual(["uncovered"]);
  });

  it("rejects a file that is not a PNG and skips one that is missing", () => {
    const { directory, file } = writePicture(10, 10);
    NodeFS.writeFileSync(NodePath.join(directory, file), "not a png");
    expect(framePixelProblems(frame(file, 10), directory).map((entry) => entry.kind)).toEqual([
      "uncovered",
    ]);
    expect(framePixelProblems(frame("absent.png", 10), directory)).toEqual([]);
  });
});

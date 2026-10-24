import { describe, expect, it } from "vite-plus/test";

import "../../index.css";
import { captureSurface, WorkflowQaSelectorError } from "../../../test/workflow-fixtures/capture";

// The capture helper is what makes a screenshot trustworthy: it must refuse, loudly, to photograph
// anything but the one element the fixture names.
describe("workflow QA capture", () => {
  it("fails when the subject selector matches nothing", async () => {
    await expect(
      captureSurface({
        surface: "qa-negative",
        state: "zero-matches",
        selector: "[data-nothing-renders-this]",
        element: () => <p>Something else rendered</p>,
      }),
    ).rejects.toThrow(WorkflowQaSelectorError);
  });

  it("fails when the subject selector matches more than one element", async () => {
    await expect(
      captureSurface({
        surface: "qa-negative",
        state: "two-matches",
        selector: "[data-twin]",
        element: () => (
          <div>
            <p data-twin>One</p>
            <p data-twin>Two</p>
          </div>
        ),
      }),
    ).rejects.toThrow(/matched 2 elements/);
  });

  it("fails when the backdrop to photograph matches nothing, even if the subject exists", async () => {
    await expect(
      captureSurface({
        surface: "qa-negative",
        state: "no-backdrop",
        selector: "[data-subject]",
        frame: "[data-backdrop]",
        element: () => <p data-subject>Subject</p>,
      }),
    ).rejects.toThrow(/selector "\[data-backdrop\]" matched 0 elements/);
  });
});

import { expect, it } from "vite-plus/test";
import {
  WORKFLOW_STATE_CUE,
  WORKFLOW_STATE_TEXT,
  WORKFLOW_STATE_SEGMENT,
  WORKFLOW_STATE_MARKER,
} from "./workflowStatusAppearance";

const states = Object.keys(WORKFLOW_STATE_CUE) as Array<keyof typeof WORKFLOW_STATE_CUE>;
it.each(
  states.flatMap((left, index) => states.slice(index + 1).map((right) => [left, right] as const)),
)("%s and %s have different non-colour cues", (left, right) => {
  expect(WORKFLOW_STATE_CUE[left]).not.toEqual(WORKFLOW_STATE_CUE[right]);
});

it.each(states)("%s text, segments and markers share an unmodified colour", (state) => {
  expect(WORKFLOW_STATE_SEGMENT[state]).toContain(WORKFLOW_STATE_TEXT[state]);
  expect(WORKFLOW_STATE_MARKER[state]).toContain(WORKFLOW_STATE_TEXT[state]);
  expect(WORKFLOW_STATE_SEGMENT[state]).not.toMatch(/foreground\/\d+/);
  expect(WORKFLOW_STATE_MARKER[state]).not.toMatch(/foreground\/\d+/);
});

import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  groupWorkflowNodesByWave,
  isWorkflowScriptMessage,
  searchableWorkflowOpeningSegments,
  workflowOpeningParentThreadId,
  workflowOpeningTitles,
  workflowPhaseTitles,
} from "./workflowOpeningText.ts";

const SCRIPT = "// plan\nexport const meta = { name: 'audit' };";
const parent = ThreadId.make("parent");
const nativeChild = {
  lineage: {
    parentThreadId: parent,
    relationshipToParent: "subagent" as const,
    rootThreadId: parent,
  },
  creationSource: "provider" as const,
};

it("treats the server's mark as the answer and falls back to the text only without one", () => {
  expect(isWorkflowScriptMessage({ role: "user", text: SCRIPT })).toBe(true);
  expect(isWorkflowScriptMessage({ role: "user", text: SCRIPT, workflowScript: false })).toBe(
    false,
  );
  expect(isWorkflowScriptMessage({ role: "user", text: "Explain `export const meta`." })).toBe(
    false,
  );
  expect(isWorkflowScriptMessage({ role: "assistant", text: SCRIPT })).toBe(false);
});

it("opens a workflow only for the first user message of a provider-native subagent thread", () => {
  const script = { role: "user", text: SCRIPT } as const;
  const prose = { role: "user", text: "Hello" } as const;
  expect(workflowOpeningParentThreadId({ thread: nativeChild, messages: [script, prose] })).toBe(
    parent,
  );
  expect(
    workflowOpeningParentThreadId({ thread: nativeChild, messages: [prose, script] }),
  ).toBeNull();
  expect(
    workflowOpeningParentThreadId({
      thread: { ...nativeChild, creationSource: "server" },
      messages: [script],
    }),
  ).toBeNull();
  expect(workflowOpeningParentThreadId({ thread: nativeChild, messages: [] })).toBeNull();
});

it("names the workflow, then what it does, and shows a distinct description once", () => {
  expect(workflowOpeningTitles({ name: "Audit", description: "Check ledgers" })).toEqual({
    title: "Audit",
    description: "Check ledgers",
  });
  expect(workflowOpeningTitles({ name: null, description: "Check ledgers" })).toEqual({
    title: "Check ledgers",
    description: null,
  });
  expect(workflowOpeningTitles({ name: "Audit", description: "Audit" }).description).toBeNull();
  expect(workflowOpeningTitles({ name: null, description: null })).toEqual({
    title: "Workflow",
    description: null,
  });
});

it("lets declared phase titles overwrite the titles the members guessed", () => {
  expect(
    workflowPhaseTitles({
      declared: [{ index: 1, title: "Declared" }],
      members: [
        { phaseIndex: 2, phaseTitle: null },
        { phaseIndex: 1, phaseTitle: "Guessed" },
        { phaseIndex: 0, phaseTitle: "First" },
        { phaseIndex: null, phaseTitle: "Loose" },
      ],
    }),
  ).toEqual([
    { index: 0, title: "First" },
    { index: 1, title: "Declared" },
    { index: 2, title: "Phase 3" },
  ]);
});

it("groups nodes by ascending wave and keeps plan order inside a wave", () => {
  const nodes = [
    { key: "c", wave: 2 },
    { key: "a", wave: 0 },
    { key: "d", wave: 2 },
    { key: "b", wave: 0 },
  ];
  expect(groupWorkflowNodesByWave(nodes).map((wave) => wave.map((node) => node.key))).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
});

it("lists the declaration in drawn order, without the script, status lines or idle phases", () => {
  expect(searchableWorkflowOpeningSegments(null)).toEqual(["Workflow"]);
  expect(
    searchableWorkflowOpeningSegments({
      title: "Reconcile\nledgers",
      workflow: {
        name: "Quarterly audit",
        phases: [
          { index: 0, title: "Gather" },
          { index: 2, title: "Never started" },
        ],
        agents: [
          { index: 0, label: "Read", state: "running", phaseIndex: 0 },
          { index: 1, label: "Loose", state: "queued" },
        ],
      },
    }),
  ).toEqual(["Quarterly audit", "Reconcile ledgers", "Gather"]);
  expect(
    searchableWorkflowOpeningSegments({
      title: null,
      workflow: {
        phases: [{ index: 0, title: "Ignored for a graph" }],
        agents: [{ index: 0, label: "Read", state: "running", phaseIndex: 0 }],
        plan: {
          nodes: [
            { key: "b", label: "Second", wave: 1, dependsOn: ["a"] },
            { key: "a", label: "First", wave: 0, dependsOn: [] },
          ],
        },
      },
    }),
  ).toEqual(["Workflow", "First", "Second"]);
});

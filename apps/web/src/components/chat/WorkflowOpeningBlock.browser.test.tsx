import type {
  RuntimeSubagent,
  WorkflowGraphView,
  WorkflowOpening,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import type ChatMarkdown from "../ChatMarkdown";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";
import { WorkflowWaveCanvas } from "./WorkflowWaveCanvas";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));
vi.mock(import("../ChatMarkdown"), async () => {
  const { memo } = await import("react");
  return {
    default: memo(({ text }: ComponentProps<typeof ChatMarkdown>) => <pre>{text}</pre>),
  };
});

const opening: WorkflowOpening = {
  messageId: "workflow-result",
  name: "Script workflow",
  description: null,
  script: "return result;",
  driver: null,
  providerInstanceId: null,
  group: null,
};

it("reveals and refolds the complete long result with the keyboard", async () => {
  const progress = `Script output\n${"  untouched <data> & `code`\n".repeat(500)}FINAL RESULT`;
  const container = document.createElement("div");
  container.style.width = "400px";
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={opening}
      environmentId={EnvironmentId.make("test")}
      progress={progress}
      onOpenThread={() => {}}
    />,
    { container },
  );
  const reveal = screen.getByRole("button", { name: "Show full result" });
  await expect.element(reveal).toBeVisible();
  const content = screen.getByText(progress, { exact: true }).element();
  expect(content.textContent).toBe(progress);
  expect(content.clientHeight).toBeLessThan(content.scrollHeight);

  await userEvent.tab();
  await expect.element(reveal).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const collapse = screen.getByRole("button", { name: "Show less", expanded: true });
  await expect.element(collapse).toHaveFocus();
  await expect.element(collapse).toBeVisible();
  expect(content.clientHeight).toBe(content.scrollHeight);
  expect(getComputedStyle(content).whiteSpace).toBe("pre-wrap");
  expect(content.textContent).toBe(progress);

  await userEvent.keyboard(" ");
  await expect.element(reveal).toHaveFocus();
  await expect.element(reveal).toHaveAttribute("aria-expanded", "false");
  expect(content.clientHeight).toBeLessThan(content.scrollHeight);
  expect(content.textContent).toBe(progress);
});

it("keeps a concise failure summary readable without a disclosure", async () => {
  const progress = "Graph failed: Audit: permission denied. 2 nodes skipped.";
  await using screen = await render(
    <WorkflowOpeningBlock
      opening={opening}
      environmentId={EnvironmentId.make("test")}
      progress={progress}
      onOpenThread={() => {}}
    />,
  );
  await expect.element(screen.getByText(progress, { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Show full result" }))
    .not.toBeInTheDocument();
});

it("lets keyboard users inspect a checker with no child thread", async () => {
  const reason = "The selected provider refused to start the checker.";
  const checker: RuntimeSubagent = {
    id: "checker",
    kind: "workflow_agent",
    title: "Audit checker",
    role: null,
    model: "full-model-identity-that-does-not-fit-in-the-card",
    providerInstanceId: ProviderInstanceId.make("review-provider"),
    effort: null,
    status: "failed",
    activationCount: 0,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: reason,
    outputFile: null,
    parentAgentId: null,
    agentIndex: 1,
    phaseIndex: null,
    phaseTitle: null,
    attempt: 0,
    workflowName: null,
    phases: [],
    runHandles: null,
    childThreadId: null,
    recentActivity: [],
    judgmentFor: { agentIndex: 0, attempt: 0, graphNodeKey: "audit" },
    firstSeenAt: "2026-10-23T00:00:00Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-23T00:00:00Z",
  };
  const graph: WorkflowGraphView<RuntimeSubagent> = {
    waves: [
      [
        {
          key: "audit",
          label: "Audit",
          wave: 0,
          dependsOn: [],
          dependents: [],
          state: "failed",
          reason,
          attempts: 1,
          member: null,
          checkers: [checker],
        },
      ],
    ],
    counts: { failed: 1 },
    waitingOn: null,
    otherMembers: [],
  };
  await using screen = await render(
    <WorkflowWaveCanvas
      graph={graph}
      environmentId={EnvironmentId.make("test")}
      onOpenThread={() => {}}
    />,
  );
  await userEvent.tab();
  await expect.element(screen.getByRole("group", { name: "Audit", exact: true })).toHaveFocus();
  await userEvent.tab();
  const trigger = screen.getByRole("group", { name: "Audit checker", exact: true });
  await expect.element(trigger).toHaveFocus();
  await expect
    .element(trigger)
    .toHaveAccessibleDescription(
      `Check attempt 1: failed · review-provider / ${checker.model} · ${reason}`,
    );
  const popup = page.getByText("Audit checker: Check attempt 1: failed", { exact: false });
  await expect.element(popup).toBeVisible();
  expect(popup.element().textContent).toContain(checker.model);
  expect(popup.element().textContent).toContain(reason);
  await userEvent.keyboard("{Escape}");
  await expect.element(popup).not.toBeInTheDocument();
});

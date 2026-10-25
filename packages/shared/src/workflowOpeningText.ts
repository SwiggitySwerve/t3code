/**
 * The one owner of what a workflow opening says and which of that text find-in-thread sees, so the
 * client draws and the server counts the same strings. Searchable text is the declaration only:
 * status lines and the agents inside a phase change with every update and are not searchable.
 */
import {
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2SubagentWorkflow,
} from "@t3tools/contracts";

// Workflow scripts open with their `meta` export, after any leading comments.
const WORKFLOW_SCRIPT_START = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*export\s+const\s+meta\b/;

/**
 * Whether a user message is the script a provider-native workflow runs. Servers mark every
 * subagent prompt either way; only threads recorded before the mark fall back to the text.
 */
export function isWorkflowScriptMessage(message: {
  readonly role: string;
  readonly text: string;
  readonly workflowScript?: boolean | undefined;
}): boolean {
  return (
    message.role === "user" && (message.workflowScript ?? WORKFLOW_SCRIPT_START.test(message.text))
  );
}

/**
 * The parent thread whose subagent rows describe this thread's workflow, or null when the thread
 * does not open with a workflow script. Gates loading the parent so ordinary subagent threads
 * never subscribe to their parent's detail.
 */
export function workflowOpeningParentThreadId(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "lineage" | "creationSource">;
  readonly messages: ReadonlyArray<Parameters<typeof isWorkflowScriptMessage>[0]>;
}): OrchestrationV2AppThread["id"] | null {
  if (!isProviderNativeSubagentThread(input.thread)) return null;
  const first = input.messages.find((message) => message.role === "user");
  return first !== undefined && isWorkflowScriptMessage(first)
    ? input.thread.lineage.parentThreadId
    : null;
}

/** The block's heading: the workflow's name, else what it does, and that description if distinct. */
export function workflowOpeningTitles(input: {
  readonly name: string | null;
  readonly description: string | null;
}): { readonly title: string; readonly description: string | null } {
  const title = input.name ?? input.description ?? "Workflow";
  return {
    title,
    description:
      input.description !== null && input.description !== title ? input.description : null,
  };
}

/**
 * A script's phases by index. The declared plan lags the members, because the provider only
 * admits a phase once something in it starts: members seed the titles, then the declared titles
 * overwrite whatever they guessed.
 */
export function workflowPhaseTitles(input: {
  readonly declared: ReadonlyArray<{ readonly index: number; readonly title: string }>;
  readonly members: ReadonlyArray<{
    readonly phaseIndex: number | null;
    readonly phaseTitle: string | null;
  }>;
}): ReadonlyArray<{ readonly index: number; readonly title: string }> {
  const titles = new Map<number, string>();
  for (const member of input.members) {
    if (member.phaseIndex === null) continue;
    titles.set(
      member.phaseIndex,
      member.phaseTitle ?? titles.get(member.phaseIndex) ?? `Phase ${member.phaseIndex + 1}`,
    );
  }
  for (const phase of input.declared) titles.set(phase.index, phase.title);
  return Array.from(titles.entries())
    .map(([index, title]) => ({ index, title }))
    .sort((a, b) => a.index - b.index);
}

/** A graph's nodes by wave (dependency depth), in plan order within each wave. */
export function groupWorkflowNodesByWave<Node extends { readonly wave: number }>(
  nodes: ReadonlyArray<Node>,
): ReadonlyArray<ReadonlyArray<Node>> {
  return [...new Set(nodes.map((node) => node.wave))]
    .sort((a, b) => a - b)
    .map((wave) => nodes.filter((node) => node.wave === wave));
}

/**
 * The text the opening block draws for find, in the order it draws it, one string per element
 * the client marks searchable. `row` is the coordinator's subagent row, or null while the parent
 * thread has not delivered it (the block then draws only its fallback title).
 */
export function searchableWorkflowOpeningSegments(
  row: {
    readonly title: string | null;
    readonly workflow?:
      | Pick<OrchestrationV2SubagentWorkflow, "name" | "phases" | "agents" | "plan">
      | undefined;
  } | null,
): ReadonlyArray<string> {
  const workflow = row?.workflow;
  const { title, description } = workflowOpeningTitles({
    name: workflow?.name ?? null,
    description: row?.title ?? null,
  });
  // A graph draws node by node; a script draws the phases that have started an agent.
  const declaration =
    workflow === undefined
      ? []
      : workflow.plan !== undefined
        ? groupWorkflowNodesByWave(workflow.plan.nodes).flatMap((wave) =>
            wave.map((node) => node.label),
          )
        : workflowPhaseTitles({
            declared: workflow.phases,
            members: workflow.agents.map((agent) => ({
              phaseIndex: agent.phaseIndex ?? null,
              phaseTitle: agent.phaseTitle ?? null,
            })),
          })
            .filter((phase) => workflow.agents.some((agent) => agent.phaseIndex === phase.index))
            .map((phase) => phase.title);
  return [title, ...(description === null ? [] : [description]), ...declaration].map((text) =>
    text.replace(/\r?\n/g, " "),
  );
}

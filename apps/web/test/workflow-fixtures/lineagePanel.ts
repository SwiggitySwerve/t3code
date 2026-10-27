/**
 * The thread facts the Lineage panel reads for a thread that started a T3 workflow: the workflow's
 * own projected row, and the thread of its first agent, which carries a title of its own. The
 * panel's hooks are mocked with these (see ThreadRelationshipsControl.browser.test.tsx).
 */
import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";

import { QA_ENVIRONMENT } from "./providers";
import { workflowFixture } from "./workflowFixtures";

export const LINEAGE_PARENT = ThreadId.make("qa-parent");
/** The thread the fixture gives the workflow's first agent. */
const LINEAGE_FIRST_AGENT_THREAD = ThreadId.make("qa-thread-0");
/** What the first agent's thread is called; never the workflow's name. */
export const LINEAGE_FIRST_AGENT_TITLE = "Write out/s05/1.txt";

const shell = (input: {
  readonly id: ThreadId;
  readonly title: string;
  readonly parent: ThreadId | null;
}) =>
  ({
    id: input.id,
    environmentId: QA_ENVIRONMENT,
    projectId: "qa-project",
    title: input.title,
    status: "running",
    activityRunStatus: "running",
    forkedFrom: null,
    lineage: {
      parentThreadId: input.parent,
      relationshipToParent: input.parent === null ? null : "subagent",
    },
  }) as unknown as OrchestrationV2ThreadShell;

/** A running graph workflow started from `LINEAGE_PARENT`, whose first agent has its own thread. */
export function lineagePanelFixture() {
  // The server projects a T3-run workflow without a name of its own; its title is what the block shows.
  const { row: named } = workflowFixture("graph", "running");
  const { name: _name, ...workflow } = named.workflow!;
  const row = { ...named, workflow };
  const parent = shell({ id: LINEAGE_PARENT, title: "Coordinator", parent: null });
  const firstAgent = shell({
    id: LINEAGE_FIRST_AGENT_THREAD,
    title: LINEAGE_FIRST_AGENT_TITLE,
    parent: LINEAGE_PARENT,
  });
  return {
    workflowTitle: row.title,
    shells: [parent, firstAgent] as ReadonlyArray<OrchestrationV2ThreadShell>,
    projection: {
      thread: parent,
      subagents: [row],
      contextTransfers: [],
      runs: [],
      providerThreads: [],
      providerSessions: [],
    },
  };
}

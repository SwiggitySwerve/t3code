import { it } from "vite-plus/test";

import "../index.css";
import { captureSurface } from "../../test/workflow-fixtures/capture";
import { SidebarStatusSurface } from "../../test/workflow-fixtures/surfaces";
import { WORKFLOW_QA_SIDEBAR_STATES } from "../../test/workflow-fixtures/workflowFixtures";

// States the default row cannot tell apart today. Each is a finding about the row, kept as its own
// state so the unit that fixes it has a before frame to compare.
const ALIASES: Partial<
  Record<(typeof WORKFLOW_QA_SIDEBAR_STATES)[number], { of: string; reason: string }>
> = {
  queued: {
    of: "running",
    reason:
      "resolveSidebarThreadStatus maps preparing, queued, starting and running to Working, so a queued thread reads exactly like a running one.",
  },
  "turn-ended-workflow-running": {
    of: "waiting-idle",
    reason:
      "The sidebar resolver ignores pendingBackgroundTasks until U9 gives it a status owner, so a parent whose workflow still runs looks exactly like an idle parent. U9 must make this frame differ.",
  },
};

it.each(WORKFLOW_QA_SIDEBAR_STATES)("sidebar status, %s", async (state) => {
  await captureSurface({
    surface: "sidebar-status",
    state,
    // The status badge is production output; the row chrome around it is the fixture's.
    selector: '[data-qa-sidebar] [role="status"]',
    frame: "[data-qa-sidebar]",
    widthIndependent: true,
    ...(ALIASES[state] === undefined ? {} : { alias: ALIASES[state] }),
    element: () => <SidebarStatusSurface state={state} />,
  });
});

import { it } from "vite-plus/test";

import "../index.css";
import { captureSurface } from "../../test/workflow-fixtures/capture";
import { SidebarStatusSurface } from "../../test/workflow-fixtures/surfaces";
import { WORKFLOW_QA_SIDEBAR_STATES } from "../../test/workflow-fixtures/workflowFixtures";

it.each(WORKFLOW_QA_SIDEBAR_STATES)("sidebar status, %s", async (state) => {
  await captureSurface({
    surface: "sidebar-status",
    state,
    // The badge is production output with no role or test id; the fixture's slot marks where it
    // sits, and the badge root is that slot's only child.
    selector: "[data-qa-sidebar-status] > span",
    frame: "[data-qa-sidebar]",
    widthIndependent: true,
    element: () => <SidebarStatusSurface state={state} />,
  });
});

import { NodeId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { readQaAtom } from "../../../test/workflow-fixtures/atoms";
import { QA_ENVIRONMENT } from "../../../test/workflow-fixtures/providers";
import { workflowFixture } from "../../../test/workflow-fixtures/workflowFixtures";
import { act, render } from "../../../test/render";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentThreadDetails } from "../../state/threads";
import { toastManager } from "../ui/toast";
import { AppWorkflowTimelineBlock } from "./AppWorkflowTimelineBlock";

const PARENT = ThreadId.make("qa-parent");
const stop = vi.hoisted(() => vi.fn());
const projection = vi.hoisted(() => ({ subagents: [] as ReadonlyArray<unknown> }));

// The block reads its row and the Stop permission through the app's atoms; the provider catalog
// comes from the workflow fixtures' own stubs, and any other atom throws. The app modules are
// imported statically: a factory for the atom library must not import them.
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) => {
    if (atom === environmentThreadDetails.threadAtom(scopeThreadRef(QA_ENVIRONMENT, PARENT))) {
      const thread = { projection };
      return selector === undefined ? thread : selector(thread);
    }
    if (atom === orchestrationEnvironment.stopWorkflow.permissionAtom(QA_ENVIRONMENT)) return true;
    return readQaAtom(atom, selector);
  }) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => stop) as never,
}));

const failure = AsyncResult.failure<void, unknown>(Cause.fail(new Error("offline")));

/** The workflow's own row, as a partly failed stop leaves it: cancelled, with a member still running. */
function showWorkflow(options: {
  readonly rowStatus: "running" | "cancelled";
  readonly member: string;
}) {
  const { row } = workflowFixture("script", "running");
  projection.subagents = [
    { ...row, status: options.rowStatus },
    {
      ...row,
      id: NodeId.make("qa-member"),
      workflow: undefined,
      parentNodeId: row.id,
      childThreadId: ThreadId.make("qa-member-thread"),
      status: options.member,
    },
  ];
  return (
    <AppWorkflowTimelineBlock
      parentRef={scopeThreadRef(QA_ENVIRONMENT, PARENT)}
      subagentId={NodeId.make(row.id)}
      onOpenThread={() => {}}
      fallback={<p>fallback</p>}
    />
  );
}

const stopButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[aria-label^="Stop workflow"]');

describe("workflow block Stop", () => {
  it("stays on a cancelled workflow while a member it started still runs, through a failed stop and a remount", async () => {
    stop.mockReset();
    stop.mockResolvedValue(failure);
    const add = vi.spyOn(toastManager, "add");
    const element = showWorkflow({ rowStatus: "cancelled", member: "running" });
    {
      await using screen = await render(element, { router: false });
      expect(stopButton(screen.container)).not.toBeNull();
      await act(async () => stopButton(screen.container)!.click());
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith({
        environmentId: QA_ENVIRONMENT,
        input: { threadId: PARENT, subagentId: "qa-workflow" },
      });
      expect(add).toHaveBeenCalledWith({ type: "error", title: "Could not stop workflow" });
      // The failure leaves the button to try again, and a second try sends the whole stop again.
      expect(stopButton(screen.container)!.disabled).toBe(false);
      await act(async () => stopButton(screen.container)!.click());
      expect(stop).toHaveBeenCalledTimes(2);
    }
    // A new mount reads the same projection, so nothing local is needed to keep Stop.
    await using again = await render(element, { router: false });
    expect(stopButton(again.container)).not.toBeNull();
    add.mockRestore();
  });

  it("goes away once the workflow and every member have settled", async () => {
    await using screen = await render(
      showWorkflow({ rowStatus: "cancelled", member: "cancelled" }),
      {
        router: false,
      },
    );
    expect(screen.container.textContent).toContain("Workflow stopped");
    expect(stopButton(screen.container)).toBeNull();
  });

  it("is offered on a running workflow", async () => {
    await using screen = await render(showWorkflow({ rowStatus: "running", member: "completed" }), {
      router: false,
    });
    expect(stopButton(screen.container)).not.toBeNull();
  });
});

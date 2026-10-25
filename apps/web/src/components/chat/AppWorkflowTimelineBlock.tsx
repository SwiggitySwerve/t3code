import { useAtomValue } from "@effect/atom-react";
import {
  appWorkflowHeading,
  canStopWorkflow,
  resolveAppWorkflowView,
  workflowProgressText,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { NodeId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";

/**
 * A workflow T3 runs for this thread (workflow_start): its phases and agents in the timeline,
 * with Stop while it runs. Any other subagent item renders `fallback`.
 */
export function AppWorkflowTimelineBlock(props: {
  readonly parentRef: ScopedThreadRef;
  readonly subagentId: NodeId;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly fallback: ReactNode;
}) {
  const row = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => thread?.projection.subagents.find((agent) => agent.id === props.subagentId) ?? null,
  );
  const canStop = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(props.parentRef.environmentId),
  );
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const [stopping, setStopping] = useState(false);
  const opening = row === null ? null : resolveAppWorkflowView(row);
  if (row === null || opening === null) return props.fallback;
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    const result = await stopWorkflow({
      environmentId: props.parentRef.environmentId,
      input: { threadId: props.parentRef.threadId, subagentId: row.id },
    });
    setStopping(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not stop workflow" });
    }
  };
  return (
    <WorkflowOpeningBlock
      opening={opening}
      environmentId={props.parentRef.environmentId}
      onOpenThread={(threadId) => props.onOpenThread(threadId as ThreadId)}
      heading={appWorkflowHeading(row.status)}
      // While it runs, the script's latest log line; afterwards, what it returned or why it ended.
      progress={workflowProgressText(row)}
      {...(canStop && canStopWorkflow(row)
        ? { stop: { onStop: () => void stop(), stopping, disabled: stopping } }
        : {})}
    />
  );
}

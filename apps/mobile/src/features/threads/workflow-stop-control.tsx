import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  canStopWorkflow,
  canStopWorkflowWork,
  isAppWorkflow,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  NodeId,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Notice } from "../../components/ui/Notice";
import { cn } from "../../lib/cn";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveSubagentRowPresentation } from "./threadAgentsPresentation";

type StopProps = {
  readonly environmentId: EnvironmentId;
  /** The thread whose subagent row is the workflow: a coordinator's parent, never its own thread. */
  readonly threadId: ThreadId;
  readonly workflowId: string;
  readonly title: string;
  /** Show only while a stop asked for here is open or has failed, so it can be retried. */
  readonly retryOnly?: boolean;
  readonly className?: string;
};

type StopState = "idle" | "stopping" | "failed";

/**
 * Stops a whole workflow, not a provider run: the command names the thread that owns the workflow
 * row and the row itself. Rendered only where the destination environment grants the operate scope.
 * State belongs to one target, so a new target starts idle and an old result cannot reach it.
 */
export function WorkflowStopControl(props: StopProps) {
  return (
    <WorkflowStopButton
      key={`${props.environmentId}:${props.threadId}:${props.workflowId}`}
      {...props}
    />
  );
}

function WorkflowStopButton(props: StopProps) {
  const canOperate = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(props.environmentId),
  );
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow, "stop workflow");
  const [state, setState] = useState<StopState>("idle");
  // A second tap can land before the first one's render disables the button.
  const inFlight = useRef(false);
  if (!canOperate || (props.retryOnly === true && state === "idle")) return null;
  const stopping = state === "stopping";
  const requestStop = async (): Promise<StopState> => {
    const result = await stopWorkflow({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, subagentId: NodeId.make(props.workflowId) },
    });
    return AsyncResult.isSuccess(result) || isAtomCommandInterrupted(result) ? "idle" : "failed";
  };
  const settle = (next: StopState) => {
    inFlight.current = false;
    setState(next);
  };
  const stop = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("stopping");
    // No try/finally: the React Compiler cannot lower a try without a catch. A rejected request
    // still ends as a failed stop that can be retried, and the rejection still propagates.
    await requestStop().then(settle, (cause: unknown) => {
      settle("failed");
      throw cause;
    });
  };
  return (
    <View className={cn("gap-1", props.className)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Stop workflow ${props.title}`}
        accessibilityState={{ disabled: stopping, busy: stopping }}
        disabled={stopping}
        onPress={() => void stop()}
        // px, not rem: native rem is 14, so min-h-11 would be 38.5 points.
        className="min-h-[44px] items-center justify-center self-start rounded-full border border-border px-5 active:bg-subtle"
      >
        <Text className="font-t3-medium text-sm text-foreground">
          {stopping ? "Stopping\u2026" : "Stop"}
        </Text>
      </Pressable>
      {state === "failed" ? (
        <Notice tone="danger" message="Could not stop the workflow. Try again." />
      ) : null}
    </View>
  );
}

type AppWorkflowStopProps = {
  readonly environmentId: EnvironmentId;
  readonly subagent: Pick<
    OrchestrationV2Subagent,
    | "id"
    | "threadId"
    | "title"
    | "prompt"
    | "progress"
    | "result"
    | "status"
    | "origin"
    | "driver"
    | "childThreadId"
    | "workflow"
  >;
  readonly className?: string;
};

/** Stop for a workflow row T3 runs itself (a parent thread's subagent with no thread of its own). */
export function AppWorkflowStop(props: AppWorkflowStopProps) {
  return isAppWorkflow(props.subagent) ? <AppWorkflowStopRow {...props} /> : null;
}

function AppWorkflowStopRow(props: AppWorkflowStopProps) {
  const { subagent } = props;
  // A stop cancels the row before it stops the members, so a failed member stop leaves the row
  // cancelled with members still running. The same control stays to retry until they settle.
  const stoppable = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, subagent.threadId)),
    (thread) => canStopWorkflowWork(subagent, thread?.projection.subagents ?? []),
  );
  const running = canStopWorkflow(subagent);
  if (!stoppable) return null;
  return (
    <WorkflowStopControl
      environmentId={props.environmentId}
      threadId={subagent.threadId}
      workflowId={subagent.id}
      title={resolveSubagentRowPresentation(subagent).title}
      retryOnly={!running}
      {...(props.className === undefined ? {} : { className: props.className })}
    />
  );
}

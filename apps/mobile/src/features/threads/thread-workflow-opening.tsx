import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  appWorkflowHeading,
  canStopWorkflow,
  deriveWorkflowProgress,
  workflowSettledText,
  resolveWorkflowOpening,
  workflowOpeningHeadline,
  workflowOpeningParentThreadId,
  type RuntimeSubagent,
  type WorkflowOpening,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { environmentThreadDetails } from "../../state/threads";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";
import { SubagentRow } from "./SubagentRow";
import { WorkflowStopControl } from "./workflow-stop-control";
import { WorkLogBlock } from "./work-log-layout";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

const FOLDED_SCRIPT_LINES = 10;

/** An opening plus the parent thread that owns the coordinator's workflow row. */
export type WorkflowOpeningView = WorkflowOpening & { readonly parentThreadId: ThreadId };

const NO_THREAD_ATOM = Atom.make<EnvironmentThread | null>(null);

export function useWorkflowOpening(ref: ScopedThreadRef | null): WorkflowOpeningView | null {
  const threadAtom = ref === null ? NO_THREAD_ATOM : environmentThreadDetails.threadAtom(ref);
  // Selected as a primitive so an ordinary thread's updates never change the result.
  const parentId = useAtomValue(threadAtom, (thread) =>
    thread === null
      ? null
      : workflowOpeningParentThreadId({
          thread: thread.projection.thread,
          messages: thread.projection.messages,
        }),
  );
  const projection = useAtomValue(threadAtom, (thread) =>
    parentId === null ? null : (thread?.projection ?? null),
  );
  const parentSubagents = useAtomValue(
    ref === null || parentId === null
      ? NO_THREAD_ATOM
      : environmentThreadDetails.threadAtom(scopeThreadRef(ref.environmentId, parentId)),
    (parent) => (parentId === null ? null : (parent?.projection.subagents ?? null)),
  );
  if (projection === null || parentId === null) return null;
  const opening = resolveWorkflowOpening({
    thread: projection.thread,
    messages: projection.messages,
    parentSubagents,
  });
  return opening === null ? null : { ...opening, parentThreadId: parentId };
}

function memberRowSubagent(
  member: RuntimeSubagent,
  opening: WorkflowOpeningValue,
  coordinatorThreadId: ThreadId,
) {
  return {
    // A member's parent thread is the coordinator's thread, the one showing this opening.
    threadId: coordinatorThreadId,
    childThreadId: member.childThreadId as ThreadId | null,
    model: member.model,
    driver: opening.driver!,
    providerInstanceId: opening.providerInstanceId!,
    title: member.title,
    prompt: member.intent ?? member.title,
    status: member.status,
    progress: undefined,
    result: member.result ?? member.error,
  };
}

type WorkflowOpeningValue = WorkflowOpeningView;

export function ThreadWorkflowOpening(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly opening: WorkflowOpeningValue;
}) {
  const openLinkedThread = useOpenLinkedThread();
  const { opening } = props;
  const headline = workflowOpeningHeadline(opening);
  const workflow = opening.group?.workflow ?? null;
  // A coordinator thread is a provider-native workflow; its row lives on the parent thread.
  const canStop =
    workflow !== null &&
    canStopWorkflow({ status: workflow.status, origin: "provider_native", driver: opening.driver });
  const canListMembers = opening.driver !== null && opening.providerInstanceId !== null;
  const phases = opening.group === null ? [] : deriveWorkflowProgress(opening.group).phases;
  const renderMember = (member: RuntimeSubagent) => {
    const threadId = member.childThreadId;
    return (
      <Pressable
        key={member.id}
        accessibilityRole={threadId === null ? undefined : "link"}
        accessibilityHint={threadId === null ? undefined : "Opens this agent's thread"}
        disabled={threadId === null}
        onPress={() => {
          if (threadId !== null)
            openLinkedThread({ environmentId: String(props.environmentId), threadId });
        }}
        className="rounded-lg px-3 py-3 active:bg-subtle"
      >
        <SubagentRow
          environmentId={props.environmentId}
          subagent={memberRowSubagent(member, opening, props.threadId)}
          elapsed={null}
        />
      </Pressable>
    );
  };
  return (
    <WorkLogBlock>
      <View className="mb-5 gap-3">
        <View className="flex-row items-start gap-2">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="font-t3-medium text-2xs text-foreground-muted">
              {workflow === null ? "Workflow started" : appWorkflowHeading(workflow.status)}
            </Text>
            <Text numberOfLines={1} className="font-t3-medium text-sm text-foreground">
              {headline.title}
            </Text>
            {headline.description ? (
              <Text className="text-xs text-foreground-muted">{headline.description}</Text>
            ) : null}
          </View>
          {headline.agents ? (
            <Text className="shrink-0 text-2xs tabular-nums text-foreground-muted">
              {headline.agents}
            </Text>
          ) : null}
        </View>
        {workflow !== null && canStop ? (
          <WorkflowStopControl
            environmentId={props.environmentId}
            threadId={opening.parentThreadId}
            workflowId={workflow.id}
            title={headline.title}
          />
        ) : null}
        {canListMembers
          ? phases.map((phase) => (
              <View key={phase.id} className="gap-px">
                <Text className="px-1 pt-1 font-t3-medium text-2xs text-foreground-muted">
                  {phase.title} · {workflowSettledText(phase.counts)}
                  {phase.state === null ? "" : ` · ${phase.state}`}
                </Text>
                {phase.tasks.flatMap((task) =>
                  task.member === null ? [] : [renderMember(task.member)],
                )}
              </View>
            ))
          : null}
        <WorkflowScript script={opening.script} />
      </View>
    </WorkLogBlock>
  );
}

function WorkflowScript(props: { readonly script: string }) {
  const [expanded, setExpanded] = useState(false);
  const { themeAppearance } = useAppearancePreferences();
  const script = props.script.trimEnd();
  const lines = useMarkdownCodeHighlight({
    code: script,
    language: "javascript",
    theme: themeAppearance,
    enabled: true,
  });
  const lineCount = script.split("\n").length;
  const canFold = lineCount > FOLDED_SCRIPT_LINES;
  const shownLines = canFold && !expanded ? FOLDED_SCRIPT_LINES : lineCount;
  let offset = 0;
  const highlighted = lines?.slice(0, shownLines).flatMap((line, lineIndex) => {
    const separator = lineIndex > 0 ? "\n" : "";
    offset += separator.length;
    return [
      separator,
      ...line.map((token) => {
        const start = offset;
        offset += token.content.length;
        return (
          <Text key={start} style={token.color ? { color: token.color } : undefined}>
            {token.content}
          </Text>
        );
      }),
    ];
  });
  return (
    <View className="gap-1">
      <View className="rounded-lg bg-subtle px-3 py-2.5">
        <Text selectable className="font-mono text-2xs leading-normal text-foreground">
          {highlighted ?? script.split("\n").slice(0, shownLines).join("\n")}
        </Text>
      </View>
      {canFold ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          className="self-start py-1 active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-foreground-muted">
            {expanded ? "Show less" : "Show full script"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

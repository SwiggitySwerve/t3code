import {
  type SubagentWorkflowGroup,
  type RuntimeSubagent,
  type WorkflowPhaseProgress,
  deriveWorkflowProgress,
  workflowPhaseStatus,
  workflowSettledFraction,
  workflowSettledText,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { ChevronDownIcon, SquareIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AgentElapsed } from "./AgentElapsed";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";
import { workflowMemberStatusText } from "./workflowStatusText";
import { cn } from "../../lib/utils";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { CollapsibleSectionHeader, SectionHeaderStatus } from "../ui/collapsible-section-header";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * What the Lineage header of a workflow shows at its right: how the run stands in words, and how
 * long it has run. Stop takes its place while the row is hovered.
 */
export function WorkflowLineageStatus(props: {
  readonly workflow: RuntimeSubagent;
  readonly className?: string | undefined;
}) {
  const status = workflowMemberStatusText(props.workflow.status);
  return (
    <span
      className={cn(
        "flex shrink-0 items-baseline gap-1.5 text-2xs font-normal tabular-nums text-muted-foreground",
        props.className,
      )}
    >
      <span className={cn("font-medium", status.className)}>{status.label}</span>
      <AgentElapsed agent={props.workflow} compact />
    </span>
  );
}

function phaseElapsed(
  phase: WorkflowPhaseProgress & { readonly members: ReadonlyArray<RuntimeSubagent> },
) {
  const instants = (key: "startedAt" | "completedAt") =>
    phase.members
      .map((member) => member[key])
      .filter((value) => value !== null)
      .sort();
  const running = phase.state === "running" || phase.counts.running > 0;
  const startedAt = instants("startedAt")[0] ?? null;
  const completedAt = running ? null : (instants("completedAt").at(-1) ?? null);
  return {
    status: running ? ("running" as const) : ("completed" as const),
    startedAt: running || completedAt !== null ? startedAt : null,
    completedAt,
  };
}

function WorkflowMemberRow({
  member,
  providerInstanceId,
  provider,
  providers,
  driver,
  onOpen,
  isThreadAvailable,
}: {
  member: RuntimeSubagent;
  providerInstanceId: ProviderInstanceId;
  provider: ServerProvider | undefined;
  providers: ReadonlyArray<ServerProvider> | undefined;
  driver: ProviderDriverKind | undefined;
  onOpen: (threadId: string) => void;
  isThreadAvailable: (threadId: string) => boolean;
}) {
  const threadId = member.childThreadId;
  const canOpen = threadId !== null && isThreadAvailable(threadId);
  const statusText = workflowMemberStatusText(member.status);
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              part="row"
              multiline
              aria-label={`Open ${member.title} chat`}
              disabled={!canOpen}
              onClick={() => canOpen && onOpen(threadId)}
            />
          }
        >
          <ThreadRelationshipIcon driver={driver} provider={provider} status={member.status} />
          <span className="line-clamp-2 min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">
            {member.title}
          </span>
          <span className="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">
            <span className={cn("font-medium", statusText.className)}>{statusText.label}</span>
            {member.startedAt ? (
              <>
                {" "}
                <AgentElapsed agent={member} />
              </>
            ) : null}
          </span>
        </TooltipTrigger>
        <ThreadHoverCardPopup side="left">
          <SubagentTooltipContent
            title={member.title}
            model={member.model}
            providerInstanceId={providerInstanceId}
            origin="provider_native"
            provider={provider}
            providers={providers}
            driver={driver}
            elapsed={<AgentElapsed agent={member} />}
            status={member.status}
            result={member.result ?? member.error}
            progress={member.progress}
          />
        </ThreadHoverCardPopup>
      </Tooltip>
    </li>
  );
}

/**
 * What a workflow is called in the Lineage list: its own name, otherwise the title it was started
 * with. The row's header and its Stop and Expand labels all read it, so they never disagree; the
 * first agent's thread title is another name for the work and is never a label for the workflow.
 */
export function workflowLineageLabel(workflow: {
  readonly workflowName: string | null;
  readonly title: string;
}): string {
  return workflow.workflowName ?? workflow.title;
}

export function ThreadLineageWorkflowRow({
  group,
  header,
  providerInstanceId,
  provider,
  providers,
  driver,
  onOpenThread,
  isThreadAvailable,
  onStop,
  stopping,
  stopDisabled,
}: {
  readonly group: SubagentWorkflowGroup;
  readonly header: ReactNode;
  readonly providerInstanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly driver: ProviderDriverKind | undefined;
  readonly onOpenThread: (threadId: string) => void;
  readonly isThreadAvailable: (threadId: string) => boolean;
  readonly onStop?: (() => void) | undefined;
  readonly stopping: boolean;
  readonly stopDisabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [phaseOpen, setPhaseOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const label = workflowLineageLabel(group.workflow);
  const overview = deriveWorkflowProgress(group);
  const phases = overview.phases
    .filter((phase) => phase.id !== "other" && (phase.tasks.length > 0 || phase.state !== null))
    .map((phase) => ({
      ...phase,
      members: phase.tasks.flatMap((task) => (task.member === null ? [] : [task.member])),
    }));
  const otherMembers =
    overview.phases
      .find((phase) => phase.id === "other")
      ?.tasks.flatMap((task) => (task.member === null ? [] : [task.member])) ?? [];
  // T3-run workflows record each agent's own provider; Claude's run on the workflow's.
  const memberProvider = (member: RuntimeSubagent) =>
    member.providerInstanceId === undefined
      ? { providerInstanceId, provider, driver }
      : {
          providerInstanceId: member.providerInstanceId,
          provider: providers?.find((entry) => entry.instanceId === member.providerInstanceId),
          driver: member.driver ?? driver,
        };
  return (
    <li className="group @container" data-workflow-expanded={expanded ? "" : undefined}>
      <div className={cn("relative", THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS)}>
        {header}
        {onStop ? (
          <div className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    tone="destructive"
                    aria-label={`Stop workflow ${label}`}
                    disabled={stopDisabled}
                    onClick={onStop}
                  />
                }
              >
                {stopping ? (
                  <Spinner size="xs" aria-hidden />
                ) : (
                  <SquareIcon aria-hidden className="size-3 fill-current" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="left">Stop entire workflow</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="secondary"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </ThreadDetailsControl>
      </div>
      {expanded ? (
        <ul className="m-0 list-none p-0 ps-6.5">
          {phases.map((phase) => {
            const status = workflowPhaseStatus(phase);
            const open = phaseOpen.get(phase.id) ?? status === "running";
            return (
              <li key={phase.id}>
                <CollapsibleSectionHeader
                  variant="panel"
                  tone={status === "running" ? "emphasized" : "muted"}
                  expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${phase.title} phase, ${status}`}
                  onClick={() => setPhaseOpen((phases) => new Map(phases).set(phase.id, !open))}
                  accessory={
                    <>
                      {status === "failed" ? (
                        <SectionHeaderStatus>Failed</SectionHeaderStatus>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span
                              className="shrink-0 text-2xs font-normal tabular-nums"
                              aria-label={workflowSettledText(phase.counts)}
                            />
                          }
                        >
                          {workflowSettledFraction(phase.counts)}
                          {/* The unit goes first in a narrow panel, so the count and time stay whole. */}
                          <span className="@max-[18rem]:hidden">
                            {phase.counts.total === 1 ? " agent" : " agents"}
                          </span>
                        </TooltipTrigger>
                        <TooltipPopup side="left">{workflowSettledText(phase.counts)}</TooltipPopup>
                      </Tooltip>
                      <span className="shrink-0 text-2xs font-normal tabular-nums empty:hidden">
                        <AgentElapsed agent={phaseElapsed(phase)} />
                      </span>
                    </>
                  }
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="block max-w-[34cqw] truncate @max-[18rem]:max-w-[24cqw]" />
                      }
                    >
                      {phase.title}
                    </TooltipTrigger>
                    <TooltipPopup side="left">{phase.title}</TooltipPopup>
                  </Tooltip>
                </CollapsibleSectionHeader>
                {open ? (
                  <ul className="m-0 list-none p-0">
                    {phase.members.map((member) => (
                      <WorkflowMemberRow
                        key={member.id}
                        member={member}
                        {...memberProvider(member)}
                        providers={providers}
                        onOpen={onOpenThread}
                        isThreadAvailable={isThreadAvailable}
                      />
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {otherMembers.map((member) => (
            <WorkflowMemberRow
              key={member.id}
              member={member}
              {...memberProvider(member)}
              providers={providers}
              onOpen={onOpenThread}
              isThreadAvailable={isThreadAvailable}
            />
          ))}
          {phases.length === 0 && otherMembers.length === 0 ? (
            <li className="px-2.5 py-1.5 text-2xs text-muted-foreground/70">No agents yet</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

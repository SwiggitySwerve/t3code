import { useAtomValue } from "@effect/atom-react";
import {
  isTerminalSubagentStatus,
  workflowGraphHeadline,
  workflowOpeningHeadline,
  type RuntimeSubagent,
  type WorkflowOpening,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { ChevronRightIcon, SquareIcon, WorkflowIcon } from "lucide-react";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { useEffect, useId, useRef, useState } from "react";

import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { EnvironmentSubagentAvatar } from "./V2LifecycleRow";
import { WorkflowWaveCanvas } from "./WorkflowWaveCanvas";

/**
 * A workflow's plan and agents in the timeline. The script, or a graph's generated runner, is debug
 * detail: it stays on `opening.script` and is never drawn here.
 */
export function WorkflowOpeningBlock(props: {
  readonly opening: WorkflowOpening;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: string) => void;
  /** Defaults to "Workflow started"; a T3-run workflow names its state instead. */
  readonly heading?: string;
  /** The script's latest log line, for a workflow T3 runs. */
  readonly progress?: string | null;
  /**
   * Whether find-in-thread reads this block's declaration (title, description, phase titles, node
   * labels), as for a coordinator thread, where the server counts the same text from the same
   * row. Other blocks are not searchable, so find never paints text it cannot count.
   */
  readonly findable?: boolean;
  readonly stop?: {
    readonly onStop: () => void;
    readonly stopping: boolean;
    readonly disabled: boolean;
  };
}) {
  const { opening } = props;
  const find = props.findable === true ? "true" : undefined;
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
  const headline = workflowOpeningHeadline(opening);
  // A graph shows node by node; a script, which declares no dependencies, keeps its phases.
  const graph = opening.group?.graph ?? null;
  const graphHeadline = graph === null ? null : workflowGraphHeadline(graph);
  const phases =
    graph !== null ? [] : (opening.group?.phases.filter((phase) => phase.members.length > 0) ?? []);
  const counts = graphHeadline?.summary ?? headline.agents;
  const memberRow = (member: RuntimeSubagent) => {
    const providerInstanceId = member.providerInstanceId ?? opening.providerInstanceId;
    return providerInstanceId === null ? null : (
      <WorkflowMemberRow
        key={member.id}
        member={member}
        environmentId={props.environmentId}
        providerInstanceId={providerInstanceId}
        providers={providers}
        driver={member.driver ?? opening.driver ?? undefined}
        onOpenThread={props.onOpenThread}
      />
    );
  };
  return (
    <section
      aria-label={`Workflow started: ${headline.title}`}
      className="flex min-w-0 flex-col gap-3 px-1 py-0.5"
      data-workflow-opening
    >
      <header className="flex min-w-0 items-start gap-2">
        <WorkflowIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-2xs font-medium text-muted-foreground">
            {props.heading ?? "Workflow started"}
          </p>
          <h3 className="truncate text-sm font-medium text-foreground" data-thread-find-text={find}>
            {headline.title}
          </h3>
          {headline.description ? (
            <p className="text-xs text-muted-foreground" data-thread-find-text={find}>
              {headline.description}
            </p>
          ) : null}
        </div>
        {counts ? (
          <span aria-live="polite" className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {counts}
          </span>
        ) : null}
        {props.stop ? (
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={`Stop workflow ${headline.title}`}
            disabled={props.stop.disabled}
            onClick={props.stop.onStop}
          >
            {props.stop.stopping ? (
              <Spinner size="xs" aria-hidden />
            ) : (
              <SquareIcon aria-hidden className="size-3 fill-current" />
            )}
            Stop
          </Button>
        ) : null}
      </header>
      {opening.budget === undefined ? null : <WorkflowBudgetMeter budget={opening.budget} />}
      {props.progress ? <WorkflowProgress text={props.progress} /> : null}
      {graphHeadline?.waitingOn ? (
        <p className="truncate px-2 text-2xs text-foreground">{graphHeadline.waitingOn}</p>
      ) : null}
      {graph !== null ? (
        <WorkflowWaveCanvas
          graph={graph}
          environmentId={props.environmentId}
          findable={props.findable === true}
          onOpenThread={props.onOpenThread}
        />
      ) : null}
      {graph !== null && graph.otherMembers.length > 0 ? (
        <section aria-label="Other workflow agents">
          <p className="px-2 text-2xs text-muted-foreground">
            Other agents · node association unavailable
          </p>
          <ul className="m-0 list-none p-0">{graph.otherMembers.map(memberRow)}</ul>
        </section>
      ) : null}
      {phases.map((phase) => (
        <section key={phase.index} aria-label={`${phase.title} phase`}>
          <h4 className="flex items-baseline gap-2 px-2 pb-0.5 text-2xs font-medium text-muted-foreground">
            <span className="min-w-0 truncate" data-thread-find-text={find}>
              {phase.title}
            </span>
            <span className="shrink-0 font-normal tabular-nums">
              {phase.settledCount}/{phase.members.length}
            </span>
          </h4>
          <ul className="m-0 list-none p-0">{phase.members.map(memberRow)}</ul>
        </section>
      ))}
      {graph === null && opening.group && opening.group.unphasedMembers.length > 0 ? (
        <ul className="m-0 list-none p-0">{opening.group.unphasedMembers.map(memberRow)}</ul>
      ) : null}
    </section>
  );
}

function WorkflowBudgetMeter({
  budget,
}: {
  readonly budget: NonNullable<WorkflowOpening["budget"]>;
}) {
  const spent =
    budget.spent === null
      ? "Unknown usage"
      : `${budget.complete ? "" : "At least "}${formatTokens(budget.spent)} tokens recorded`;
  return (
    <div className="px-2 text-2xs text-muted-foreground" data-workflow-budget>
      <p>
        {spent} / {budget.limit === null ? "no" : formatTokens(budget.limit)} token budget
      </p>
      {budget.limit !== null && budget.limit > 0 && budget.spent !== null ? (
        <progress
          className="h-1 w-full"
          aria-label="Recorded workflow token usage"
          value={Math.min(budget.spent, budget.limit)}
          max={budget.limit}
        />
      ) : null}
      <p className={budget.exhausted ? "text-warning" : undefined}>
        {budget.overshot ? "Budget exceeded. " : budget.exhausted ? "Budget exhausted. " : ""}
        The budget stops new starts. Already-running agents may exceed it.
        {budget.complete ? "" : " Usage is incomplete."}
      </p>
    </div>
  );
}

function WorkflowProgress(props: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const contentId = useId();
  useEffect(() => {
    const element = textRef.current;
    if (element === null || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight);
    measure();
    return observeResize(element, measure);
  });
  return (
    <div>
      <p
        ref={textRef}
        id={contentId}
        className={cn(
          "break-words whitespace-pre-wrap px-2 text-2xs text-muted-foreground",
          !expanded && "line-clamp-3",
        )}
      >
        {props.text}
      </p>
      {overflows || expanded ? (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-expanded={expanded}
          aria-controls={contentId}
          data-scroll-anchor-ignore
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show full result"}
        </Button>
      ) : null}
    </div>
  );
}

/** One member agent, drawn like the timeline's subagent rows; it opens the member's thread. */
function WorkflowMemberRow(props: {
  readonly member: RuntimeSubagent;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly driver: ProviderDriverKind | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { member } = props;
  const threadId = member.childThreadId;
  const failed = member.status === "failed";
  const detail = (
    isTerminalSubagentStatus(member.status)
      ? (member.error ?? member.result ?? member.progress)
      : member.progress
  )
    ?.replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const className =
    "group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left";
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            threadId === null ? (
              <div aria-description={member.status} className={className} />
            ) : (
              <button
                type="button"
                aria-label={`Open ${member.title}`}
                aria-description={member.status}
                onClick={() => props.onOpenThread(threadId)}
                className={cn(
                  className,
                  "cursor-pointer transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                )}
              />
            )
          }
        >
          <EnvironmentSubagentAvatar
            environmentId={props.environmentId}
            providerInstanceId={props.providerInstanceId}
            driver={props.driver}
            status={member.status}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">
              {member.title}
            </span>
            {detail ? (
              <span
                className={cn(
                  "block truncate text-2xs leading-relaxed",
                  failed ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {detail}
              </span>
            ) : null}
          </span>
          {member.startedAt ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              <AgentElapsed agent={member} />
            </span>
          ) : null}
          {threadId !== null ? (
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/subagent:text-foreground"
            />
          ) : null}
        </TooltipTrigger>
        <ThreadHoverCardPopup>
          <SubagentTooltipContent
            title={member.title}
            model={member.model}
            providerInstanceId={props.providerInstanceId}
            origin="provider_native"
            provider={props.providers.find(
              (provider) => provider.instanceId === props.providerInstanceId,
            )}
            providers={props.providers}
            driver={props.driver}
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

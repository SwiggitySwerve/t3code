import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockIcon,
  HourglassIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";

import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";

import { useNowSecond } from "../../hooks/useNowSecond";
import { resolveSidebarV2TopStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import type { SidebarV2TopStatusKind } from "../Sidebar.logic";

export interface SidebarTopStatus {
  readonly label: string;
  readonly icon:
    | "working"
    | "queued"
    | "waiting"
    | "approval"
    | "input"
    | "request"
    | "failed"
    | "done"
    | "woke";
  readonly className: string;
}

/** The label, icon and color the default sidebar row shows for each top status. */
export function sidebarThreadTopStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  readonly goalActive: boolean;
}): SidebarTopStatus | null {
  const kind: SidebarV2TopStatusKind | null = resolveSidebarV2TopStatus(input);
  switch (kind) {
    case "working":
      return {
        label: input.goalActive ? "Goal" : "Working",
        icon: "working",
        className: "text-info-foreground",
      };
    case "queued":
      return { label: "Queued", icon: "queued", className: "text-muted-foreground" };
    case "background":
      // The turn ended but a workflow or other background work keeps running.
      return { label: "Running", icon: "working", className: "text-info-foreground" };
    case "waiting":
      return { label: "Waiting", icon: "waiting", className: "text-muted-foreground" };
    case "approval":
      return { label: "Approval", icon: "approval", className: "text-warning-foreground" };
    case "input":
      return {
        label: "Input",
        icon: "input",
        className: "text-indigo-600 dark:text-indigo-300",
      };
    case "request":
      return { label: "Request", icon: "request", className: "text-guest-foreground" };
    case "limited":
      return { label: "Limited", icon: "failed", className: "text-warning-foreground" };
    case "failed":
      return { label: "Failed", icon: "failed", className: "text-error-foreground" };
    case "woke":
      return { label: "Woke", icon: "woke", className: "text-warning-foreground" };
    case "done":
      return { label: "Done", icon: "done", className: "text-success-foreground" };
    case null:
      return null;
  }
}

function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) return null;
  return <WorkingDurationLabel startedMs={startedMs} />;
}

// Self-ticking so only this span re-renders each second, not the whole row;
// the shared tick lands every working row's update in the same frame.
function WorkingDurationLabel(props: { startedMs: number }) {
  const nowMs = useNowSecond();
  return (
    <span className="tabular-nums">{formatWorkingDurationLabel(nowMs - props.startedMs)}</span>
  );
}

/**
 * The status a default sidebar row shows at its right edge, for every top status but Woke (which
 * is a dismiss button the row owns). `durationStartedAt` is set while the thread is working or
 * waiting, and the duration ticks from it.
 */
export function SidebarTopStatusBadge(props: {
  readonly topStatus: SidebarTopStatus;
  readonly durationStartedAt: string | null | undefined;
}) {
  const { topStatus } = props;
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${topStatus.className}`}>
      {topStatus.icon === "working" ? (
        <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
      ) : topStatus.icon === "queued" ? (
        <ClockIcon aria-hidden className="size-4 shrink-0" />
      ) : topStatus.icon === "waiting" ? (
        <HourglassIcon aria-hidden className="size-4 shrink-0" />
      ) : topStatus.icon === "input" ? (
        <MessageCircleQuestionIcon aria-hidden className="size-4 shrink-0" />
      ) : topStatus.icon === "request" ? (
        <UserRoundIcon aria-hidden className="size-4 shrink-0" />
      ) : topStatus.icon === "approval" ? (
        <ShieldQuestionIcon aria-hidden className="size-4 shrink-0" />
      ) : topStatus.icon === "failed" ? (
        <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
      ) : topStatus.icon === "done" ? (
        <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
      ) : null}
      {/* Not a live region: a collapsed sidebar is inert, so BackgroundThreadAnnouncer and the open
          thread's timeline speak status changes instead. */}
      {topStatus.label}
      {props.durationStartedAt === undefined ? null : (
        <span aria-hidden>
          <WorkingDuration startedAt={props.durationStartedAt} />
        </span>
      )}
    </span>
  );
}

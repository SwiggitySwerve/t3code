import {
  AlarmClockIcon,
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
import { cn } from "../../lib/utils";
import { SIDEBAR_THREAD_STATUS_LABELS, type SidebarThreadStatus } from "../Sidebar.logic";

const TOP_STATUS_ICONS = {
  working: CircleDashedIcon,
  queued: ClockIcon,
  waiting: HourglassIcon,
  input: MessageCircleQuestionIcon,
  request: UserRoundIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  woke: AlarmClockIcon,
} as const;

export interface SidebarTopStatus {
  readonly label: string;
  readonly icon: keyof typeof TOP_STATUS_ICONS;
  readonly className: string;
}

export function TopStatusIcon(props: { icon: keyof typeof TOP_STATUS_ICONS; className: string }) {
  const Icon = TOP_STATUS_ICONS[props.icon];
  return <Icon aria-hidden className={cn("shrink-0", props.className)} />;
}

/** The label, icon and color the default sidebar row shows for each top status. */
export function sidebarThreadTopStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  readonly goalActive: boolean;
}): SidebarTopStatus | null {
  switch (input.status) {
    case "preparing":
      return { label: "Setting up", icon: "working", className: "text-info-foreground" };
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
      return { label: "Working", icon: "working", className: "text-info-foreground" };
    case "waiting":
      return { label: "Waiting", icon: "waiting", className: "text-muted-foreground" };
    case "approval":
      return {
        label: SIDEBAR_THREAD_STATUS_LABELS.approval,
        icon: "approval",
        className: "text-warning-foreground",
      };
    case "input":
      return {
        label: SIDEBAR_THREAD_STATUS_LABELS.input,
        icon: "input",
        className: "text-indigo-600 dark:text-indigo-300",
      };
    case "request":
      return { label: "Request", icon: "request", className: "text-guest-foreground" };
    case "limited":
      return {
        label: SIDEBAR_THREAD_STATUS_LABELS.limited,
        icon: "failed",
        className: "text-warning-foreground",
      };
    case "failed":
      return { label: "Failed", icon: "failed", className: "text-error-foreground" };
    default:
      if (input.isWoke) {
        return { label: "Woke", icon: "woke", className: "text-warning-foreground" };
      }
      return input.isUnread
        ? { label: "Done", icon: "done", className: "text-success-foreground" }
        : null;
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
    <span
      data-sidebar-top-status
      className={cn("inline-flex items-center gap-1 font-medium", topStatus.className)}
    >
      <TopStatusIcon icon={topStatus.icon} className="size-4" />
      {/* Not a live region: a collapsed sidebar is inert, so
        BackgroundThreadAnnouncer and the open thread's
        timeline speak status changes instead. */}
      {topStatus.label}
      {props.durationStartedAt === undefined ? null : (
        <span aria-hidden>
          <WorkingDuration startedAt={props.durationStartedAt} />
        </span>
      )}
    </span>
  );
}

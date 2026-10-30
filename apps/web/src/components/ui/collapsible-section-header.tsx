import type { ComponentProps, ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../../lib/utils";

const tones = {
  muted: { label: "text-sidebar-muted-foreground", line: "bg-sidebar-border/50" },
  emphasized: { label: "text-sidebar-foreground/80", line: "bg-sidebar-foreground/25" },
  accent: { label: "text-primary", line: "bg-primary/50" },
} as const;

export function CollapsibleSectionHeader({
  children,
  expanded,
  tone = "muted",
  variant = "default",
  accessory,
  meter,
  ...buttonProps
}: Omit<ComponentProps<"button">, "className" | "style" | "aria-expanded"> & {
  expanded: boolean;
  tone?: keyof typeof tones;
  variant?: "default" | "panel";
  accessory?: ReactNode;
  /** A fixed-width inline bar after the label; hidden, never narrowed, when the row lacks room. */
  meter?: ReactNode;
}) {
  return (
    <button
      {...buttonProps}
      type="button"
      aria-expanded={expanded}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        variant === "panel" ? "ps-2 pe-2.5" : "px-2",
        tones[tone].label,
      )}
    >
      <span className="shrink-0">{children}</span>
      {meter === undefined ? (
        <span
          aria-hidden
          // A header with a trailing count drops its rule so it doesn't read as a leader.
          className={cn("h-px min-w-2 flex-1", tones[tone].line, accessory && "invisible")}
        />
      ) : (
        // Takes the rule's place, so the row's minimum width is unchanged.
        <span aria-hidden className="@container/meter flex min-w-0 flex-1 items-center">
          <span className="flex w-14 shrink-0 items-center @max-[3.5rem]/meter:hidden">
            {meter}
          </span>
        </span>
      )}
      {accessory}
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")}
      />
    </button>
  );
}

export function SectionHeaderStatus({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 text-3xs leading-none text-destructive-foreground">{children}</span>
  );
}

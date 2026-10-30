import { Tooltip } from "@base-ui/react/tooltip";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { observeResize } from "../../lib/observeResize";

export function WorkflowAgentReadout(props: {
  readonly anchor: HTMLButtonElement;
  readonly id: string;
  readonly children: ReactNode;
}) {
  const [boundary, setBoundary] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the composer can resize without moving the active cell; refresh the positioner's collision bounds before paint.
  useLayoutEffect(() => {
    const viewport = props.anchor.closest("[data-assistant-citation-viewport]");
    const element = viewport?.querySelector("[data-chat-readout-boundary]") ?? viewport;
    if (!element) return;
    const measure = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      setBoundary({ x, y, width, height });
    };
    measure();
    const stop = observeResize(element, measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      stop();
      window.removeEventListener("scroll", measure, true);
    };
  }, [props.anchor]);

  return (
    <Tooltip.Root open disableHoverablePopup>
      <Tooltip.Portal>
        <Tooltip.Positioner
          anchor={props.anchor}
          side="bottom"
          sideOffset={6}
          collisionBoundary={boundary}
          collisionAvoidance={{ side: "flip", align: "shift" }}
          sticky
          className="pointer-events-none z-[140] max-w-(--available-width) data-anchor-hidden:hidden"
        >
          <Tooltip.Popup
            id={props.id}
            role="note"
            aria-label="Agent details"
            className="max-h-(--available-height) w-max overflow-hidden rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md [overflow-wrap:anywhere]"
            style={{ maxWidth: "min(20rem, var(--available-width))" }}
            data-workflow-readout
          >
            {props.children}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

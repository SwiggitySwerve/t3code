import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { observeResize } from "../../lib/observeResize";

/** The edges of a scroll area that still have content past them. */
export interface ScrollEdges {
  readonly right: boolean;
  readonly bottom: boolean;
}

const FADE_PX = 32;

/**
 * Fades the edges of a scroll area that continue past the view, so a row or card cut by the edge
 * reads as more to scroll to and not as a broken layout. Nothing fades once the end is in view.
 */
export function scrollFadeStyle(edges: ScrollEdges): CSSProperties | undefined {
  if (!edges.right && !edges.bottom) return undefined;
  const none = "linear-gradient(#000, #000)";
  const image = [
    edges.right ? `linear-gradient(to right, #000 calc(100% - ${FADE_PX}px), transparent)` : none,
    edges.bottom ? `linear-gradient(to bottom, #000 calc(100% - ${FADE_PX}px), transparent)` : none,
  ].join(", ");
  return { maskImage: image, maskComposite: "intersect", WebkitMaskComposite: "source-in" };
}

/** Which edges of the element in `ref` have content past them; updates on scroll and resize. */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ right: false, bottom: false });
  const last = useRef(edges);
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to the scroll container's scroll and resize events, which only the DOM reports.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const read = () => {
      const next = {
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
        bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1,
      };
      if (next.right === last.current.right && next.bottom === last.current.bottom) return;
      last.current = next;
      setEdges(next);
    };
    read();
    element.addEventListener("scroll", read, { passive: true });
    const stopObserving = observeResize(element, read);
    return () => {
      element.removeEventListener("scroll", read);
      stopObserving();
    };
  }, [ref]);
  return edges;
}

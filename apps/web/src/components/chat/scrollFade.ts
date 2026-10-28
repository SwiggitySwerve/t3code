import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { observeResize } from "../../lib/observeResize";

/** The edges of a scroll area that still have content past them. */
export interface ScrollEdges {
  readonly left?: boolean;
  readonly top?: boolean;
  readonly right: boolean;
  readonly bottom: boolean;
}

const FADE_PX = 32;

/**
 * Fades the edges of a scroll area that continue past the view, so a row or card cut by the edge
 * reads as more to scroll to and not as a broken layout. Nothing fades once the end is in view.
 */
export function scrollFadeStyle(edges: ScrollEdges): CSSProperties | undefined {
  if (edges.left !== true && edges.top !== true && !edges.right && !edges.bottom) return undefined;
  const solid = "linear-gradient(#000, #000)";
  const fade = (direction: string, from: boolean, to: boolean) =>
    from || to
      ? `linear-gradient(${direction}, ${from ? `transparent, #000 ${FADE_PX}px` : "#000, #000"}, ${to ? `#000 calc(100% - ${FADE_PX}px), transparent` : "#000, #000"})`
      : solid;
  const image = [
    fade("to right", edges.left === true, edges.right),
    fade("to bottom", edges.top === true, edges.bottom),
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
        left: element.scrollLeft > 1,
        top: element.scrollTop > 1,
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
        bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1,
      };
      const was = last.current;
      if (
        next.left === was.left &&
        next.top === was.top &&
        next.right === was.right &&
        next.bottom === was.bottom
      ) {
        return;
      }
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

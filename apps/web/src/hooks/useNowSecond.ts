import { secondTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

const subscribeInactive = () => () => {};
const inactiveSnapshot = () => 0;

/** The shared wall-clock second; an inactive caller subscribes to nothing. */
export function useNowSecond(active = true): number {
  return useSyncExternalStore(
    active ? secondTick.subscribe : subscribeInactive,
    active ? secondTick.getSnapshot : inactiveSnapshot,
    active ? secondTick.getSnapshot : inactiveSnapshot,
  );
}

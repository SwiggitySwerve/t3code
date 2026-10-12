import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import {
  resolveEnvironmentSelection,
  type ResolvedEnvironmentSelection,
} from "@t3tools/client-runtime/state/environment-selection";
import { EnvironmentId } from "@t3tools/contracts";

/** Resolves the persisted home environment with the shared web/mobile rules. */
export function resolveHomeEnvironmentSelection(
  storedEnvironmentId: string | null | undefined,
  environments: readonly Pick<
    EnvironmentConnectionSummary,
    "environmentId" | "isEnabled" | "connectionState"
  >[],
  isReady: boolean,
): ResolvedEnvironmentSelection {
  return resolveEnvironmentSelection(
    storedEnvironmentId
      ? {
          kind: "one",
          environmentId: EnvironmentId.make(storedEnvironmentId),
        }
      : { kind: "all" },
    environments.map((environment) => ({
      environmentId: environment.environmentId,
      enabled: environment.isEnabled,
      online: environment.connectionState === "connected",
    })),
    isReady,
  );
}

/**
 * The full-page empty state has no environment recovery, so a missing
 * selection falls through to the list empty state that offers "Show all".
 */
export function homeShowsFullPageEmptyState(input: {
  readonly hasAnyThreads: boolean;
  readonly environmentMissing: boolean;
}): boolean {
  return !input.hasAnyThreads && !input.environmentMissing;
}

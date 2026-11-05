import type { ProviderDriverKind, ProviderOptionSelection } from "@t3tools/contracts";
import type { UsageSpeed } from "@t3tools/provider-core/server/usage";

import { BUILT_IN_USAGE_DRIVERS } from "../provider/builtInDrivers.ts";

/**
 * The speed a turn started with these resolved options bills at, as its driver's usage reader
 * decides. Undefined for a driver whose usage T3 does not read, so its speed is unknown.
 */
export function selectionSpeed(
  driver: ProviderDriverKind,
  options: ReadonlyArray<ProviderOptionSelection>,
): UsageSpeed | undefined {
  const reader = BUILT_IN_USAGE_DRIVERS.find((entry) => entry.driverKind === driver)?.usage;
  if (reader === undefined) return undefined;
  return reader.selectionSpeed?.(options) ?? "standard";
}

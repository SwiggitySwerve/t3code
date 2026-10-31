import {
  OrchestratorMcpTarget,
  type OrchestrationV2WorkflowPlannedIdentity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeTarget = Schema.decodeUnknownOption(OrchestratorMcpTarget);

/** Display only: keep known requested fields without resolving or changing the spawn target. */
export function workflowPlannedIdentity(
  value: unknown,
): OrchestrationV2WorkflowPlannedIdentity | undefined {
  const decoded = decodeTarget(value);
  if (decoded._tag === "None") return undefined;
  const { providerInstanceId, driverKind, model } = decoded.value;
  if (providerInstanceId === undefined && driverKind === undefined && model === undefined)
    return undefined;
  return {
    ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
    ...(driverKind === undefined ? {} : { driver: driverKind }),
    ...(model === undefined ? {} : { model }),
  };
}

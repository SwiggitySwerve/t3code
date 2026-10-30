import {
  WORKFLOW_MEMBER_STATE,
  type RuntimeSubagent,
  type WorkflowTaskProgress,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { resolveSubagentModelLabel } from "@t3tools/client-runtime/state/subagent-display";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import {
  resolveOfficialAcpRegistryIconUrl,
  type OrchestrationV2WorkflowPlannedIdentity,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderIcon } from "@t3tools/provider-core/client";
import { formatModelSlugName, resolveModelGlyph } from "@t3tools/shared/model";
import { AntigravityIcon, ClaudeAI, OpenAI, type Icon } from "../Icons";

const DRIVER_ICONS: Readonly<Record<string, Icon>> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  antigravity: AntigravityIcon,
};

export type WorkflowIdentityIcon =
  | {
      readonly kind: "glyph";
      readonly glyph: string;
      readonly family: string;
      readonly label: string;
    }
  | { readonly kind: "package"; readonly key: string; readonly icon: ProviderIcon }
  | { readonly kind: "driver"; readonly key: string; readonly component: Icon }
  | { readonly kind: "acp"; readonly key: string; readonly url: string }
  | { readonly kind: "generic"; readonly key: "generic" };

export interface WorkflowIdentity {
  readonly key: string;
  readonly providerName: string;
  readonly modelName: string;
  readonly displayName: string;
  readonly icon: WorkflowIdentityIcon;
  readonly planned: boolean;
  readonly plannedDescription?: string;
}

export function resolveWorkflowIdentity(
  member: RuntimeSubagent | null,
  provider: ServerProvider | undefined,
  state?: WorkflowTaskProgress["state"],
  plannedIdentity: OrchestrationV2WorkflowPlannedIdentity | undefined = member?.plannedIdentity,
  plannedProvider?: ServerProvider,
): WorkflowIdentity {
  const unstarted =
    member === null ||
    (state ?? WORKFLOW_MEMBER_STATE[member.status]) === "queued" ||
    (plannedIdentity !== undefined && member.childThreadId === null && member.startedAt === null);
  const planned = plannedIdentity
    ? assignedIdentity(
        { ...plannedIdentity, model: plannedIdentity.model ?? null },
        plannedProvider ??
          (provider?.instanceId === plannedIdentity.providerInstanceId ? provider : undefined),
      )
    : undefined;
  if (unstarted) {
    return planned
      ? { ...planned, key: `planned:${planned.key}`, planned: true }
      : {
          key: "unstarted",
          providerName: "Not started",
          modelName: "Model not assigned",
          displayName: "Not started",
          icon: { kind: "generic", key: "generic" },
          planned: false,
        };
  }
  const actual = assignedIdentity(member, provider);
  const changed =
    plannedIdentity !== undefined &&
    ((plannedIdentity.providerInstanceId !== undefined &&
      plannedIdentity.providerInstanceId !== member.providerInstanceId) ||
      (plannedIdentity.driver !== undefined &&
        plannedIdentity.driver !== (provider?.driver ?? member.driver)) ||
      (plannedIdentity.model !== undefined &&
        member.model !== null &&
        planned?.modelId !== actual.modelId));
  return {
    ...actual,
    planned: false,
    ...(changed && planned
      ? { plannedDescription: `${planned.providerName} · ${planned.modelName}` }
      : {}),
  };
}

function assignedIdentity(
  member: Pick<RuntimeSubagent, "model" | "providerInstanceId" | "driver">,
  provider: ServerProvider | undefined,
): Omit<WorkflowIdentity, "planned" | "plannedDescription"> & { readonly modelId: string | null } {
  const driver = provider?.driver ?? member?.driver;
  const providerName = provider
    ? resolveProviderInstanceDisplayName(provider)
    : member.providerInstanceId
      ? "Provider removed"
      : "Provider not assigned";
  const modelName =
    resolveSubagentModelLabel({ model: member.model, provider }) ??
    (member.model ? formatModelSlugName(member.model) : "Unknown model");
  const glyph = resolveModelGlyph(member.model, driver);
  // The registry package's logo identifies the registry, not the configured agent.
  const packageIcon = driver === "acpRegistry" ? undefined : providerClients.get(driver)?.icon;
  const DriverIcon = driver === undefined ? undefined : DRIVER_ICONS[driver];
  const acp = provider ? resolveOfficialAcpRegistryIconUrl(provider.iconUrl ?? null) : null;
  const icon: WorkflowIdentityIcon = glyph
    ? { kind: "glyph", glyph: glyph.glyph, family: glyph.family, label: glyph.label }
    : packageIcon
      ? { kind: "package", key: `driver:${driver}`, icon: packageIcon }
      : DriverIcon
        ? { kind: "driver", key: `driver:${driver}`, component: DriverIcon }
        : acp
          ? { kind: "acp", key: `acp:${acp}`, url: acp }
          : { kind: "generic", key: "generic" };
  return {
    modelId: glyph?.modelId ?? member.model,
    key: `${member.providerInstanceId ?? driver ?? "unknown"}:${glyph?.modelId ?? member.model ?? "unknown"}`,
    providerName,
    modelName,
    displayName: member.model ? modelName : providerName,
    icon,
  };
}

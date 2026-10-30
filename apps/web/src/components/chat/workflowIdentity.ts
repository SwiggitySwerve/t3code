import {
  WORKFLOW_MEMBER_STATE,
  type RuntimeSubagent,
  type WorkflowTaskProgress,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import { resolveOfficialAcpRegistryIconUrl, type ServerProvider } from "@t3tools/contracts";
import type { ProviderIcon } from "@t3tools/provider-core/client";
import {
  formatModelSlugName,
  resolveModelGlyph,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import { AntigravityIcon, ClaudeAI, OpenAI, type Icon } from "../Icons";
import { getDisplayModelName } from "./providerIconUtils";

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
}

export function workflowModelName(
  model: string | null,
  provider: ServerProvider | undefined,
): string {
  const slug = provider ? resolveSelectableModel(provider.driver, model, provider.models) : null;
  const catalogModel = provider?.models.find((candidate) => candidate.slug === slug);
  return catalogModel
    ? getDisplayModelName(catalogModel)
    : model
      ? formatModelSlugName(model)
      : "Unknown model";
}

export function resolveWorkflowIdentity(
  member: RuntimeSubagent | null,
  provider: ServerProvider | undefined,
  state?: WorkflowTaskProgress["state"],
): WorkflowIdentity {
  const unstarted = member === null || (state ?? WORKFLOW_MEMBER_STATE[member.status]) === "queued";
  const driver = provider?.driver ?? member?.driver;
  const providerName = unstarted
    ? "Not started"
    : provider
      ? resolveProviderInstanceDisplayName(provider)
      : "Provider removed";
  const modelName = unstarted ? "Model not assigned" : workflowModelName(member.model, provider);
  const glyph = unstarted ? null : resolveModelGlyph(member.model, driver);
  // The registry package's logo identifies the registry, not the configured agent.
  const packageIcon = driver === "acpRegistry" ? undefined : providerClients.get(driver)?.icon;
  const DriverIcon = driver === undefined ? undefined : DRIVER_ICONS[driver];
  const acp = provider ? resolveOfficialAcpRegistryIconUrl(provider.iconUrl ?? null) : null;
  const icon: WorkflowIdentityIcon = unstarted
    ? { kind: "generic", key: "generic" }
    : glyph
      ? { kind: "glyph", glyph: glyph.glyph, family: glyph.family, label: glyph.label }
      : packageIcon
        ? { kind: "package", key: `driver:${driver}`, icon: packageIcon }
        : DriverIcon
          ? { kind: "driver", key: `driver:${driver}`, component: DriverIcon }
          : acp
            ? { kind: "acp", key: `acp:${acp}`, url: acp }
            : { kind: "generic", key: "generic" };
  return {
    key: unstarted
      ? "unstarted"
      : `${member.providerInstanceId ?? driver ?? "unknown"}:${glyph?.modelId ?? member.model ?? "unknown"}`,
    providerName,
    modelName,
    displayName: unstarted ? "Not started" : member.model ? modelName : providerName,
    icon,
  };
}

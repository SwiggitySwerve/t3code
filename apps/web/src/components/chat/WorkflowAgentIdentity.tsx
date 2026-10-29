import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { resolveModelGlyph } from "@t3tools/shared/model";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** Without a label, show only the model glyph or provider icon. */
export function WorkflowAgentIdentity(props: {
  readonly member: RuntimeSubagent | null;
  readonly provider: ServerProvider | undefined;
  readonly label?: string;
}) {
  const { member, provider } = props;
  const driver = provider?.driver ?? member?.driver;
  const model = resolveModelGlyph(member?.model, driver);
  const providerName = provider
    ? resolveProviderInstanceDisplayName(provider)
    : (member?.providerInstanceId ?? "Unknown provider");
  const identity = `Provider: ${providerName}${member?.providerInstanceId ? ` (${member.providerInstanceId})` : ""}`;
  const icon = (
    <ProviderInstanceIcon
      driverKind={driver ?? ProviderDriverKind.make("unknown")}
      displayName={providerName}
      accentColor={provider?.accentColor}
      acpRegistryIconUrl={provider?.iconUrl}
      showBadge={Boolean(provider?.accentColor)}
      badgeContent="none"
      size="compact"
      iconClassName="size-3"
      badgeClassName="right-0 bottom-0 size-1 min-w-1 p-0 forced-colors:border-foreground"
    />
  );
  const glyph = (
    <span
      role="img"
      aria-label={model?.label ?? identity}
      className="flex size-3.5 shrink-0 items-center justify-center text-xs"
      data-model-glyph={model?.family}
    >
      <span aria-hidden>{model?.glyph ?? icon}</span>
    </span>
  );
  if (props.label === undefined) return glyph;
  return (
    <span className="flex min-w-0 items-center gap-1 leading-3.5" data-workflow-agent-identity>
      {glyph}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <span
        role="img"
        aria-label={identity}
        className="inline-flex h-3.5 min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded-sm border border-border px-0.5 text-3xs font-medium text-muted-foreground forced-colors:border-foreground"
        data-workflow-provider={member?.providerInstanceId ?? "unknown"}
      >
        {model ? (
          <span aria-hidden className="flex shrink-0">
            {icon}
          </span>
        ) : null}
        <span aria-hidden className="truncate">
          {providerName}
        </span>
      </span>
    </span>
  );
}

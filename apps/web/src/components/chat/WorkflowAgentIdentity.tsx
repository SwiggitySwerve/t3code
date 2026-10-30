import type {
  RuntimeSubagent,
  WorkflowTaskProgress,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ServerProvider } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { ProviderPackageIcon } from "./ProviderPackageIcon";
import { SvgCurrentColorFilter } from "../ui/svg-current-color-filter";
import {
  resolveWorkflowIdentity,
  type WorkflowIdentity,
  type WorkflowIdentityIcon,
} from "./workflowIdentity";

type SpriteIcon = Exclude<WorkflowIdentityIcon, { kind: "glyph" }>;
export type WorkflowIdentitySprite = ReadonlyMap<string, string>;

function IdentitySvg({
  icon,
  inSymbol = false,
}: {
  readonly icon: SpriteIcon;
  readonly inSymbol?: boolean;
}) {
  const [imageStatus, setImageStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const filterId = useId();
  if (icon.kind === "package")
    return <ProviderPackageIcon icon={icon.icon} width={24} height={24} inSymbol={inSymbol} />;
  if (icon.kind === "driver") {
    const Icon = icon.component;
    return <Icon width={24} height={24} />;
  }
  if (icon.kind === "acp")
    return (
      <>
        <defs>
          <SvgCurrentColorFilter id={filterId} />
        </defs>
        {imageStatus !== "loaded" ? <BotIcon width={24} height={24} /> : null}
        {imageStatus !== "failed" ? (
          <image
            href={icon.url}
            width={24}
            height={24}
            opacity={imageStatus === "loaded" ? 1 : 0}
            filter={`url(#${filterId})`}
            data-workflow-image-status={imageStatus}
            onLoad={() => setImageStatus("loaded")}
            onError={() => setImageStatus("failed")}
          />
        ) : null}
      </>
    );
  return <BotIcon width={24} height={24} />;
}

export function WorkflowIdentitySymbols(props: {
  readonly icons: ReadonlyArray<SpriteIcon>;
  readonly sprite: WorkflowIdentitySprite;
}) {
  return (
    <svg aria-hidden className="absolute size-0 overflow-hidden" data-workflow-sprite>
      <defs>
        {props.icons.map((icon) => (
          <symbol key={icon.key} id={props.sprite.get(icon.key)} viewBox="0 0 24 24">
            <IdentitySvg icon={icon} inSymbol />
          </symbol>
        ))}
      </defs>
    </svg>
  );
}

export function WorkflowAgentIdentity(props: {
  readonly member: RuntimeSubagent | null;
  readonly provider: ServerProvider | undefined;
  readonly label?: string;
  readonly grid?: boolean;
  readonly state?: WorkflowTaskProgress["state"];
  readonly identity?: WorkflowIdentity;
  readonly sprite?: WorkflowIdentitySprite;
}) {
  const identity =
    props.identity ?? resolveWorkflowIdentity(props.member, props.provider, props.state);
  const { icon } = identity;
  const symbol = icon.kind === "glyph" ? undefined : props.sprite?.get(icon.key);
  const glyph = (
    <WorkflowIdentityGlyph
      {...workflowIdentityGlyphProps(identity, props.sprite)}
      grid={props.grid}
      fallback={
        icon.kind !== "glyph" && !symbol ? <IdentitySvg key={icon.key} icon={icon} /> : undefined
      }
    />
  );
  if (props.label === undefined) return glyph;
  return (
    <span className="flex min-w-0 items-center gap-1 leading-3.5" data-workflow-agent-identity>
      {glyph}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <span
        role="img"
        aria-label={`Provider: ${identity.providerName}`}
        className="inline-flex min-w-0 max-w-[45%] shrink-0 truncate rounded-sm border border-border px-0.5 text-3xs font-medium text-muted-foreground"
        data-workflow-provider={props.member?.providerInstanceId ?? "unknown"}
      >
        {identity.providerName}
      </span>
    </span>
  );
}

export interface WorkflowIdentityGlyphProps {
  readonly kind: WorkflowIdentityIcon["kind"];
  readonly glyph?: string | undefined;
  readonly family?: string | undefined;
  readonly iconLabel: string;
  readonly light?: string | undefined;
  readonly dark?: string | undefined;
  readonly symbol?: string | undefined;
}

export function workflowIdentityGlyphProps(
  identity: WorkflowIdentity,
  sprite?: WorkflowIdentitySprite,
): WorkflowIdentityGlyphProps {
  const { icon } = identity;
  return {
    kind: icon.kind,
    glyph: icon.kind === "glyph" ? icon.glyph : undefined,
    family: icon.kind === "glyph" ? icon.family : undefined,
    iconLabel: icon.kind === "glyph" ? icon.label : `Provider: ${identity.providerName}`,
    light: icon.kind === "package" ? icon.icon.fill.light : undefined,
    dark: icon.kind === "package" ? icon.icon.fill.dark : undefined,
    symbol: icon.kind === "glyph" ? undefined : sprite?.get(icon.key),
  };
}

/** Primitive sprite props let Compiler reuse cells when unrelated agents update. */
export function WorkflowIdentityGlyph(
  props: WorkflowIdentityGlyphProps & {
    readonly grid?: boolean | undefined;
    readonly fallback?: ReactNode;
    readonly className?: string;
  },
) {
  const style = props.light
    ? ({ "--icon-light": props.light, "--icon-dark": props.dark } as CSSProperties)
    : undefined;
  return (
    <span
      role="img"
      aria-label={props.iconLabel}
      className={cn(
        "flex shrink-0 items-center justify-center leading-none",
        props.grid ? "size-4 text-base" : "size-3.5 text-xs",
        props.className,
      )}
      data-model-glyph={props.family}
      data-workflow-identity={props.kind}
    >
      {props.kind === "glyph" ? (
        props.glyph
      ) : (
        <svg aria-hidden viewBox="0 0 24 24" className="size-full" style={style}>
          {props.symbol ? <use href={`#${props.symbol}`} style={style} /> : props.fallback}
        </svg>
      )}
    </span>
  );
}

import { WorkflowAgentIdentity, type WorkflowIdentitySprite } from "./WorkflowAgentIdentity";
import type { WorkflowIdentity } from "./workflowIdentity";

export function WorkflowIdentityStack(props: {
  readonly identities: ReadonlyArray<WorkflowIdentity>;
  readonly sprite: WorkflowIdentitySprite;
}) {
  const identities = [
    ...new Map(props.identities.map((identity) => [identity.key, identity])).values(),
  ];
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" aria-label="Model identities">
      {identities.slice(0, 3).map((identity) => (
        <span
          key={identity.key}
          role="img"
          aria-label={`${identity.providerName} · ${identity.modelName}`}
        >
          <WorkflowAgentIdentity
            member={null}
            provider={undefined}
            identity={identity}
            sprite={props.sprite}
          />
        </span>
      ))}
      {identities.length > 3 ? (
        <span
          className="text-2xs text-muted-foreground"
          aria-label={`${identities.length - 3} more identities`}
        >
          +{identities.length - 3}
        </span>
      ) : null}
    </span>
  );
}

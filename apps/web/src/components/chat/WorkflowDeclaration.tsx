import { useState } from "react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { findRevealRef } from "./markdownFindContext";

export function WorkflowDeclaration(props: { readonly segments: ReadonlyArray<string> }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
        Workflow declaration
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false} keepMounted ref={findRevealRef(() => setOpen(true))}>
        <pre
          data-thread-find-text
          data-thread-find-lines
          className="max-h-60 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]"
        >
          {props.segments.map((segment) => segment.replace(/\r?\n/g, " ")).join("\n")}
        </pre>
      </CollapsiblePanel>
    </Collapsible>
  );
}

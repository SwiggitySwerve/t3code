import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { useEffect, useRef, useState } from "react";

import { recoverConnectionCatalog } from "~/connection/storage";
import { environmentCatalog } from "~/connection/catalog";
import { requestConfirmDialog } from "~/confirmDialog";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

/**
 * The connection runtime cannot start while the saved catalog is unreadable, so this is the only
 * place a user can recover. It appears only for a catalog that failed to decode.
 */
const reloadPage = () => window.location.reload();

export function CorruptCatalogNotice({
  reload = reloadPage,
}: {
  /** Rebuilds the connection runtime, which failed to start; replaced in tests. */
  readonly reload?: () => void;
}) {
  const corrupt = useAtomValue(environmentCatalog.catalogCorruptionAtom);
  const [resetting, setResetting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  if (!corrupt) return null;

  const reset = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const confirmed = await requestConfirmDialog(
        "Reset saved connections?\nThey could not be read. A copy of the unreadable data stays on this device, but you will need to add your connections again.",
        { variant: "destructive" },
      );
      if (confirmed !== true) return;
      setFailure(null);
      setResetting(true);
      const abort = new AbortController();
      controller.current = abort;
      const exit = await Effect.runPromiseExit(recoverConnectionCatalog, { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (Exit.isSuccess(exit)) {
        reload();
        return;
      }
      setFailure("Could not reset the saved connections. Nothing was changed.");
      setResetting(false);
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <Alert variant="warning">
      <AlertTitle>Saved connections could not be read</AlertTitle>
      <AlertDescription>
        {failure ??
          "Your saved connections are left as they are. Reset them to start again; a copy of the unreadable data is kept on this device."}
      </AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline" disabled={resetting} onClick={() => void reset()}>
          {resetting ? <Spinner /> : null}
          Reset connections
        </Button>
      </AlertAction>
    </Alert>
  );
}

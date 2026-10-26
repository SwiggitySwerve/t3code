import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { readCatalogAccess } from "~/connection/storage";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

/**
 * Shown on the desktop when saved connections exist but secure storage cannot decrypt them right
 * now. The app runs without them and leaves the file alone, so there is nothing to reset. A failed
 * check shows nothing: the notice only explains a state the desktop confirmed.
 */
export function SecureStorageUnavailableNotice() {
  const [unavailable, setUnavailable] = useState(false);

  // oxlint-disable-next-line t3code/react-effect-budget -- reads the desktop bridge's secure-storage state on mount and abandons the read on unmount
  useEffect(() => {
    const abort = new AbortController();
    void Effect.runPromise(readCatalogAccess, { signal: abort.signal }).then(
      (access) => setUnavailable(access === "secure-storage-unavailable"),
      () => undefined,
    );
    return () => abort.abort();
  }, []);

  if (!unavailable) return null;

  return (
    <Alert variant="warning">
      <AlertTitle>Saved connections are unavailable</AlertTitle>
      <AlertDescription>
        Saved connections can't be read because secure storage is unavailable. Nothing was changed.
      </AlertDescription>
    </Alert>
  );
}

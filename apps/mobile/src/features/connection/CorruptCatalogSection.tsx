import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Updates from "expo-updates";
import { useEffect, useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { environmentCatalog } from "../../connection/catalog";
import { recover } from "../../connection/catalog-store";
import * as MobileSecureStorage from "../../persistence/mobile-secure-storage";

type ResetState = "idle" | "resetting" | "failed" | "restart";

const FOOTERS: Record<ResetState, string> = {
  idle: "Your saved connections are left as they are. Reset them to start again; a copy of the unreadable data is kept on this device.",
  resetting: "Resetting saved connections.",
  failed: "Could not reset the saved connections. Nothing was changed.",
  restart: "Saved connections were reset. Restart the app to continue.",
};

/**
 * The connection runtime cannot start while the saved catalog is unreadable, so this is the only
 * place a user can recover. It appears only for a catalog that failed to decode.
 */
export function CorruptCatalogSection() {
  const corrupt = useAtomValue(environmentCatalog.catalogCorruptionAtom);
  const [state, setState] = useState<ResetState>("idle");
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- aborts a reset still running when the section unmounts, so it cannot update state afterwards
  useEffect(() => () => controller.current?.abort(), []);

  if (!corrupt) return null;

  const attemptReset = async (abort: AbortController) => {
    const exit = await Effect.runPromiseExit(
      recover().pipe(Effect.provide(MobileSecureStorage.layer)),
      { signal: abort.signal },
    );
    if (abort.signal.aborted) return;
    if (!Exit.isSuccess(exit)) {
      setState("failed");
      return;
    }
    // The runtime failed to build at startup; a new launch is the only way to build it again.
    await Updates.reloadAsync().catch(() => setState("restart"));
  };

  const reset = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("resetting");
    const abort = new AbortController();
    controller.current = abort;
    // Release the guard however the attempt ends: finished, failed, aborted or thrown.
    await attemptReset(abort).finally(() => {
      inFlight.current = false;
    });
  };

  return (
    <ListSection title="Saved connections could not be read" footer={FOOTERS[state]}>
      <ListActionRow
        icon="arrow.clockwise"
        label="Reset connections"
        tone="danger"
        loading={state === "resetting"}
        disabled={state === "restart"}
        onPress={() =>
          Dialog.confirm({
            title: "Reset saved connections?",
            message:
              "They could not be read. A copy of the unreadable data stays on this device, but you will need to add your connections again.",
            confirmText: "Reset",
            destructive: true,
            onConfirm: () => void reset(),
          })
        }
      />
    </ListSection>
  );
}

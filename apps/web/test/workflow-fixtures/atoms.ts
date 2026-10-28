/**
 * The atom reads the workflow fixtures stub, from the same atoms the app reads. An atom with no
 * stub throws: answering `[]` would make a permission atom read as "allowed". A `vi.mock` factory
 * for the atom library must not import this module; it calls `readQaAtom` through a static import.
 */
import { Atom } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { orchestrationEnvironment } from "../../src/state/orchestration";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "../../src/state/server";
import { QA_ENVIRONMENT, QA_PROVIDERS } from "./providers";

const workflowStopPermission = Atom.make(true).pipe(Atom.withLabel("workflow Stop permission"));

const STUBS = new Map<unknown, unknown>([
  [serverEnvironment.providersValueAtom(QA_ENVIRONMENT), QA_PROVIDERS],
  [providersIgnoringCheckedAtAtom(QA_ENVIRONMENT), QA_PROVIDERS],
  [workflowStopPermission, true],
]);

// Nested weak atom families can lose their intermediate factory while React retains the leaf.
// Stub the producer too, so the component and fixture keep the same identity across collections.
export function stubQaWorkflowStopPermission() {
  return vi
    .spyOn(orchestrationEnvironment.stopWorkflow, "permissionAtom")
    .mockImplementation((environmentId) => {
      if (environmentId !== QA_ENVIRONMENT) {
        throw new Error(`No workflow Stop permission stub for environment: ${environmentId}`);
      }
      return workflowStopPermission;
    });
}

/** What `useAtomValue(atom, selector)` returns in a fixture. */
export function readQaAtom(atom: unknown, selector?: (value: unknown) => unknown): unknown {
  if (!STUBS.has(atom)) {
    const label = Atom.isAtom(atom) ? (atom.label?.[0] ?? "<unlabelled atom>") : String(atom);
    throw new Error(`A workflow fixture read an atom it has no stub for: ${label}`);
  }
  const value = STUBS.get(atom);
  return selector === undefined ? value : selector(value);
}

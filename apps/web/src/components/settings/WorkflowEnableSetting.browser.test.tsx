import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ServerSettings,
  ServerSettingsPatch,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);

const state = vi.hoisted(() => ({
  settings: undefined as UnifiedSettings | undefined,
  listeners: new Set<() => void>(),
  canWrite: true,
  fail: false,
  throwTransportError: false,
  disk: "",
  requests: [] as { environmentId: EnvironmentId; input: { patch: ServerSettingsPatch } }[],
}));

vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    useEnvironmentSettings: (() =>
      useSyncExternalStore(
        (notify) => {
          state.listeners.add(notify);
          return () => state.listeners.delete(notify);
        },
        () => state.settings!,
      )) as typeof actual.useEnvironmentSettings,
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canWrite,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async (request: { environmentId: EnvironmentId; input: { patch: ServerSettingsPatch } }) => {
      state.requests.push(request);
      if (state.throwTransportError) throw new Error("Transport disconnected");
      if (state.fail) return AsyncResult.failure(Cause.fail(new Error("Save refused")));
      const patch = decodePatch(request.input.patch);
      const next = applyServerSettingsPatch(state.settings!, patch);
      state.disk = JSON.stringify(encodeSettings(next));
      state.settings = mergeEnvironmentSettings(
        decodeSettings(JSON.parse(state.disk)),
        DEFAULT_UNIFIED_SETTINGS,
      );
      for (const notify of state.listeners) notify();
      return AsyncResult.success(undefined);
    },
}));

import { WorkflowEnableSetting } from "./WorkflowEnableSetting";

const REMOTE = EnvironmentId.make("remote");

function setup(workflows: boolean) {
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, workflows };
  state.canWrite = true;
  state.fail = false;
  state.throwTransportError = false;
  state.disk = "";
  state.requests = [];
}

describe("enable workflows setting", () => {
  it("persists both toggle directions to the selected environment", async () => {
    setup(false);
    await using screen = await render(<WorkflowEnableSetting environmentId={REMOTE} />);
    const toggle = screen.getByRole("switch", { name: "Enable workflows" });
    await expect.element(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(decodeSettings(JSON.parse(state.disk)).workflows).toBe(true);
    await expect.element(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(decodeSettings(JSON.parse(state.disk)).workflows).toBe(false);
    expect(state.requests.map((request) => request.input.patch)).toEqual([
      { workflows: true },
      { workflows: false },
    ]);
    expect(state.requests.every((request) => request.environmentId === "remote")).toBe(true);
  });

  it("disables the switch without permission and reports a refused or failed save", async () => {
    setup(true);
    state.canWrite = false;
    await using screen = await render(<WorkflowEnableSetting environmentId={REMOTE} />);
    const toggle = screen.getByRole("switch", { name: "Enable workflows" });
    await expect.element(toggle).toBeDisabled();
    await expect
      .element(screen.getByText("This connection cannot change workflow settings."))
      .toBeInTheDocument();
    expect(state.requests).toHaveLength(0);

    state.canWrite = true;
    await screen.rerender(<WorkflowEnableSetting environmentId={REMOTE} />);
    state.fail = true;
    await userEvent.click(toggle);
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Could not save workflows. Reconnect and try again.");
    expect(state.settings!.workflows).toBe(true);

    state.fail = false;
    state.throwTransportError = true;
    await userEvent.click(toggle);
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Could not save workflows. Reconnect and try again.");
    expect(state.settings!.workflows).toBe(true);

    state.throwTransportError = false;
    await userEvent.click(toggle);
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    expect(state.settings!.workflows).toBe(false);
    expect(state.requests).toHaveLength(3);
  });
});

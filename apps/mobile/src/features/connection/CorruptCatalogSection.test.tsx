import * as Effect from "effect/Effect";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    corrupt: true,
    recover: vi.fn(),
    reload: vi.fn(),
    confirm: vi.fn(),
  },
}));

vi.mock("react-native", () => ({}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.corrupt }));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { catalogCorruptionAtom: {} },
}));
vi.mock("../../connection/catalog-store", () => ({ recover: () => mocks.recover() }));
vi.mock("../../persistence/mobile-secure-storage", async () => {
  const Layer = await import("effect/Layer");
  return { layer: Layer.empty };
});
vi.mock("expo-updates", () => ({ reloadAsync: () => mocks.reload() }));
vi.mock("../../components/ui/Dialog", () => ({
  confirm: (request: unknown) => mocks.confirm(request),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: ({
    title,
    footer,
    children,
  }: {
    title: string;
    footer: string;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
      <p data-testid="footer">{footer}</p>
    </section>
  ),
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: ({
    label,
    tone,
    loading,
    disabled,
    onPress,
  }: {
    label: string;
    tone: string;
    loading?: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      data-tone={tone}
      data-loading={loading}
      disabled={disabled || loading}
      onClick={onPress}
    >
      {label}
    </button>
  ),
}));

import { CorruptCatalogSection } from "./CorruptCatalogSection";

type ConfirmRequest = {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly destructive: boolean;
  readonly onConfirm: () => void;
};

let container: HTMLDivElement;
let root: Root;

async function mount() {
  await act(async () => root.render(<CorruptCatalogSection />));
}
const footer = () => container.querySelector("[data-testid=footer]")?.textContent;
const press = () => container.querySelector("button")!.click();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.corrupt = true;
  mocks.recover.mockReset().mockReturnValue(Effect.succeed(true));
  mocks.reload.mockReset().mockResolvedValue(undefined);
  mocks.confirm.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("CorruptCatalogSection", () => {
  it("renders nothing unless the stored catalog failed to decode", async () => {
    mocks.corrupt = false;
    await mount();
    expect(container.textContent).toBe("");
  });

  it("explains the state, and resets only after the user confirms", async () => {
    await mount();
    expect(container.querySelector("h2")?.textContent).toBe("Saved connections could not be read");
    expect(footer()).toContain("left as they are");
    expect(container.querySelector("button")?.dataset.tone).toBe("danger");

    await act(async () => press());
    const request = mocks.confirm.mock.calls[0]![0] as ConfirmRequest;
    expect(request).toMatchObject({
      title: "Reset saved connections?",
      confirmText: "Reset",
      destructive: true,
    });
    expect(request.message).toContain("add your connections again");
    expect(mocks.recover).not.toHaveBeenCalled();

    await act(async () => request.onConfirm());
    await vi.waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
    expect(mocks.recover).toHaveBeenCalledTimes(1);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it("says nothing was changed when the reset fails, and does not reload", async () => {
    mocks.recover.mockReturnValue(Effect.fail(new Error("could not preserve")));
    await mount();
    await act(async () => press());
    await act(async () => (mocks.confirm.mock.calls[0]![0] as ConfirmRequest).onConfirm());
    await vi.waitFor(() => expect(footer()).toContain("Nothing was changed"));
    expect(footer()).toBe("Could not reset the saved connections. Nothing was changed.");
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("asks for a restart when the app cannot reload itself", async () => {
    mocks.reload.mockRejectedValue(new Error("not available"));
    await mount();
    await act(async () => press());
    await act(async () => (mocks.confirm.mock.calls[0]![0] as ConfirmRequest).onConfirm());
    await vi.waitFor(() => expect(footer()).toContain("Restart the app"));
    expect(footer()).toBe("Saved connections were reset. Restart the app to continue.");
    expect(container.querySelector("button")?.disabled).toBe(true);
  });
  it("lets the user try again after a failed reset", async () => {
    mocks.recover
      .mockReturnValueOnce(Effect.fail(new Error("could not preserve")))
      .mockReturnValueOnce(Effect.succeed(true));
    await mount();
    await act(async () => press());
    const request = () => mocks.confirm.mock.calls[0]![0] as ConfirmRequest;
    await act(async () => request().onConfirm());
    await vi.waitFor(() => expect(footer()).toContain("Nothing was changed"));

    await act(async () => request().onConfirm());
    await vi.waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
    expect(mocks.recover).toHaveBeenCalledTimes(2);
  });

  it("ignores a second confirmation while a reset runs, then accepts another", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.recover
      .mockReturnValueOnce(Effect.promise(() => held).pipe(Effect.as(true)))
      .mockReturnValueOnce(Effect.fail(new Error("could not preserve")));
    await mount();
    await act(async () => press());
    const request = () => mocks.confirm.mock.calls[0]![0] as ConfirmRequest;
    await act(async () => request().onConfirm());
    await act(async () => request().onConfirm());
    expect(mocks.recover).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
    await act(async () => request().onConfirm());
    await vi.waitFor(() => expect(mocks.recover).toHaveBeenCalledTimes(2));
  });
});

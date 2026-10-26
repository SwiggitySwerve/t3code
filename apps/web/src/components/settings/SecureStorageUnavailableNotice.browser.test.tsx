import type { DesktopConnectionCatalogAccess as Access } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { SecureStorageUnavailableNotice } from "./SecureStorageUnavailableNotice";

const MESSAGE =
  "Saved connections can't be read because secure storage is unavailable. Nothing was changed.";

describe("SecureStorageUnavailableNotice", () => {
  it("says what happened and that nothing was changed, with no reset to offer", async () => {
    using _bridge = stubGlobal("desktopBridge", {
      getConnectionCatalogAccess: () => Promise.resolve<Access>("secure-storage-unavailable"),
    });
    await using screen = await render(<SecureStorageUnavailableNotice />);

    await vi.waitFor(() => expect(screen.container.textContent).toContain(MESSAGE));
    expect(screen.container.textContent).toContain("Saved connections are unavailable");
    expect(screen.container.querySelector("button")).toBeNull();
  });

  it.each([
    ["secure storage works", () => Promise.resolve<Access>("ok")],
    ["the check fails", () => Promise.reject(new Error("ipc closed"))],
  ])("shows nothing when %s", async (_name, answer) => {
    const access = vi.fn(answer);
    using _bridge = stubGlobal("desktopBridge", { getConnectionCatalogAccess: access });
    await using screen = await render(<SecureStorageUnavailableNotice />);

    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(1));
    // Let the answer, or the rejection, reach the component before checking what it rendered.
    await act(() =>
      access.mock.results[0]!.value.then(
        () => undefined,
        () => undefined,
      ),
    );
    expect(screen.container.textContent).toBe("");
  });

  it("shows nothing outside the desktop app", async () => {
    await using screen = await render(<SecureStorageUnavailableNotice />);
    expect(screen.container.textContent).toBe("");
  });
});

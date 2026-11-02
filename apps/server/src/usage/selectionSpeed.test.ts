import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { selectionSpeed } from "./selectionSpeed.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

describe("selectionSpeed", () => {
  it("bills each driver's options at the tier its usage reader records", () => {
    expect(selectionSpeed(codex, [])).toBe("standard");
    expect(selectionSpeed(codex, [{ id: "serviceTier", value: "priority" }])).toBe("fast");
    expect(selectionSpeed(codex, [{ id: "serviceTier", value: "ultrafast" }])).toBe("ultrafast");
    expect(selectionSpeed(codex, [{ id: "fastMode", value: true }])).toBe("fast");
    expect(selectionSpeed(claude, [{ id: "fastMode", value: true }])).toBe("fast");
    expect(selectionSpeed(claude, [{ id: "serviceTier", value: "priority" }])).toBe("standard");
  });

  it("does not guess for a driver whose usage T3 does not read", () => {
    expect(selectionSpeed(ProviderDriverKind.make("no-such-driver"), [])).toBeUndefined();
  });
});

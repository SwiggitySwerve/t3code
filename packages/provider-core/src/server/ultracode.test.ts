import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { applyUltracode, ULTRACODE_TURN_NOTE } from "./ultracode.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const note = `\n\n${ULTRACODE_TURN_NOTE}`;

describe("applyUltracode", () => {
  it("adds the workflow note when a message says ultracode", () => {
    expect(
      applyUltracode({
        mode: "keyword",
        driver: codex,
        text: "Audit this. Ultracode!",
        createdBy: "user",
      }),
    ).toBe(`Audit this. Ultracode!${note}`);
  });

  it("leaves other messages alone in keyword mode, and matches whole words only", () => {
    for (const text of ["Audit this.", "ultracoded", "my_ultracode_flag"]) {
      expect(applyUltracode({ mode: "keyword", driver: codex, text, createdBy: "user" })).toBe(
        text,
      );
    }
  });

  it("opts in every user or agent turn when always, but never a system wake", () => {
    expect(applyUltracode({ mode: "always", driver: codex, text: "Go", createdBy: "agent" })).toBe(
      `Go${note}`,
    );
    expect(
      applyUltracode({ mode: "always", driver: codex, text: "Task finished", createdBy: "system" }),
    ).toBe("Task finished");
  });

  it("never opts in when off", () => {
    expect(
      applyUltracode({ mode: "off", driver: codex, text: "ultracode", createdBy: "user" }),
    ).toBe("ultracode");
  });

  it("leaves Claude to its own ultracode, adding only the keyword when the user did not type it", () => {
    expect(
      applyUltracode({
        mode: "keyword",
        driver: claude,
        text: "ultracode: audit",
        createdBy: "user",
      }),
    ).toBe("ultracode: audit");
    expect(
      applyUltracode({ mode: "always", driver: claude, text: "Audit", createdBy: "user" }),
    ).toBe("Audit\n\nultracode");
  });
});

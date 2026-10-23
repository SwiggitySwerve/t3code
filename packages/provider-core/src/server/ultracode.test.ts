import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { applyUltracode, ULTRACODE_TURN_NOTE } from "./ultracode.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const note = `\n\n${ULTRACODE_TURN_NOTE}`;
const root = { creationSource: "server", delegatedThread: false } as const;
const typed = { creationSource: "web", delegatedThread: false } as const;

describe("applyUltracode", () => {
  it("adds the workflow note when a message says ultracode", () => {
    expect(
      applyUltracode({
        mode: "keyword",
        driver: codex,
        text: "Audit this. Ultracode!",
        createdBy: "user",
        ...typed,
      }),
    ).toBe(`Audit this. Ultracode!${note}`);
  });

  it("leaves other messages alone in keyword mode, and matches whole words only", () => {
    for (const text of ["Audit this.", "ultracoded", "my_ultracode_flag"]) {
      expect(
        applyUltracode({ mode: "keyword", driver: codex, text, createdBy: "user", ...typed }),
      ).toBe(text);
    }
  });

  it("opts in every user or agent turn when always, but never a system wake", () => {
    expect(
      applyUltracode({ mode: "always", driver: codex, text: "Go", createdBy: "agent", ...root }),
    ).toBe(`Go${note}`);
    expect(
      applyUltracode({
        mode: "always",
        driver: codex,
        text: "Task finished",
        createdBy: "system",
        ...root,
      }),
    ).toBe("Task finished");
  });

  it("never opts in when off", () => {
    expect(
      applyUltracode({
        mode: "off",
        driver: codex,
        text: "ultracode",
        createdBy: "user",
        ...typed,
      }),
    ).toBe("ultracode");
  });

  it("leaves Claude to its own ultracode, adding only the keyword when the user did not type it", () => {
    expect(
      applyUltracode({
        mode: "keyword",
        driver: claude,
        text: "ultracode: audit",
        createdBy: "user",
        ...typed,
      }),
    ).toBe("ultracode: audit");
    expect(
      applyUltracode({
        mode: "always",
        driver: claude,
        text: "Audit",
        createdBy: "user",
        ...typed,
      }),
    ).toBe("Audit\n\nultracode");
  });

  it("never opts a delegated or workflow child in from its agent's text or the always setting", () => {
    const child = { delegatedThread: true } as const;
    for (const mode of ["keyword", "always"] as const) {
      for (const driver of [codex, claude]) {
        // The task text an agent wrote, including the keyword it was itself given.
        expect(
          applyUltracode({
            mode,
            driver,
            text: "Scan a.ts. ultracode",
            createdBy: "agent",
            creationSource: "mcp",
            ...child,
          }),
        ).toBe("Scan a.ts. ultracode");
        // A parent's answer to the child's question arrives as a server-made user message.
        expect(
          applyUltracode({
            mode,
            driver,
            text: "Go on",
            createdBy: "user",
            creationSource: "server",
            ...child,
          }),
        ).toBe("Go on");
        // A person writing to the child without the keyword.
        expect(
          applyUltracode({
            mode,
            driver,
            text: "Go on",
            createdBy: "user",
            creationSource: "web",
            ...child,
          }),
        ).toBe("Go on");
      }
    }
  });

  it("still lets a person type the keyword into a child thread", () => {
    expect(
      applyUltracode({
        mode: "keyword",
        driver: codex,
        text: "ultracode: dig deeper",
        createdBy: "user",
        creationSource: "web",
        delegatedThread: true,
      }),
    ).toBe(`ultracode: dig deeper${note}`);
  });
});

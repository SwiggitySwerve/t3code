import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { applyUltracode as applyUltracodeTo, ULTRACODE_TURN_NOTE } from "./ultracode.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const note = `\n\n${ULTRACODE_TURN_NOTE}`;
const root = { creationSource: "server", delegatedThread: false } as const;
const typed = { creationSource: "web", delegatedThread: false } as const;

// Most cases are a message with no composer context, where the typed words are the whole text.
const applyUltracode = (
  input: Omit<Parameters<typeof applyUltracodeTo>[0], "typedWords"> & {
    readonly typedWords?: string;
  },
) => applyUltracodeTo({ typedWords: input.text, ...input });

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

  it("opts in an agent's root turn when always, but never a system wake", () => {
    expect(
      applyUltracode({
        mode: "always",
        driver: codex,
        text: "Go",
        createdBy: "agent",
        creationSource: "mcp",
        delegatedThread: false,
      }),
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

  it.each([codex, claude])(
    "leaves server-created workflow approvals unchanged for %s",
    (driver) => {
      const text = "The workflow is approved. Use graph_start with the accepted digest.";
      for (const mode of ["always", "keyword"] as const) {
        expect(applyUltracode({ mode, driver, text, createdBy: "user", ...root })).toBe(text);
        const mentioningKeyword = `${text} The request was ultracode.`;
        expect(
          applyUltracode({ mode, driver, text: mentioningKeyword, createdBy: "user", ...root }),
        ).toBe(mentioningKeyword);
      }
    },
  );

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

  it("reads the keyword from what the person typed, not from the context projected into the text", () => {
    // A context chip expands to its content in the provider text; only the typed words can opt in.
    const projected = "Look at this\n\n<t3_context>build log: ultracode run failed</t3_context>";
    for (const driver of [codex, claude]) {
      expect(
        applyUltracode({
          mode: "keyword",
          driver,
          text: projected,
          typedWords: "Look at this",
          createdBy: "user",
          ...typed,
        }),
        driver,
      ).toBe(projected);
    }
    // The typed keyword still opts in, and the note goes after the projected text.
    expect(
      applyUltracode({
        mode: "keyword",
        driver: codex,
        text: "ultracode this\n\n<t3_context>build log</t3_context>",
        typedWords: "ultracode this",
        createdBy: "user",
        ...typed,
      }),
    ).toBe(`ultracode this\n\n<t3_context>build log</t3_context>${note}`);
  });

  it("does not let context that mentions the keyword opt in a person's message to a child thread", () => {
    const projected = "Go on\n\n<t3_context>ultracode</t3_context>";
    expect(
      applyUltracode({
        mode: "keyword",
        driver: codex,
        text: projected,
        typedWords: "Go on",
        createdBy: "user",
        creationSource: "web",
        delegatedThread: true,
      }),
    ).toBe(projected);
  });
});

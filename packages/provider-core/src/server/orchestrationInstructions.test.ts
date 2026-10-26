import { describe, expect, it } from "vite-plus/test";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "./orchestrationInstructions.ts";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("coordinator fan-out guidance", () => {
  const section = T3_CODE_ORCHESTRATION_SECTIONS.find((candidate) =>
    candidate.startsWith("### Fan-out and effort"),
  );

  it("tells the coordinator to default to one agent and to size fan-out", () => {
    expect(section).toBeDefined();
    expect(section).toContain("Default to one agent");
    expect(section).toContain("Split by context, never by role");
    expect(T3_CODE_ORCHESTRATION_INSTRUCTIONS).toContain(section);
  });

  it("stays under 1 KB", () => {
    expect(bytes(section ?? "")).toBeLessThan(1_000);
  });

  it("keeps a requested workflow and points at the advisory and the suggested budget", () => {
    expect(section).toContain("graph_review");
    expect(section).toContain("never swap the workflow for one agent");
    expect(section).toContain("suggestedBudgetTokens");
    expect(section).toContain("budgetTokens excludes your own tokens");
  });

  it("is its own section after the existing ones, within Codex's per-entry cap", () => {
    expect(T3_CODE_ORCHESTRATION_SECTIONS.at(-1)).toBe(section);
    for (const entry of T3_CODE_ORCHESTRATION_SECTIONS)
      expect(bytes(entry)).toBeLessThanOrEqual(4_000);
  });
});

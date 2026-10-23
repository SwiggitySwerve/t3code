import { describe, expect, it } from "@effect/vitest";

import { judgmentPrompt } from "./workflowChecks.ts";

describe("judgmentPrompt", () => {
  it("tells a judge of work in another checkout to judge the result alone", () => {
    const prompt = (workspaceVisible: boolean) =>
      judgmentPrompt({ task: "t", result: "r", rubric: ["c"], workspaceVisible });
    expect(prompt(true)).toContain("Read the workspace if a criterion needs it");
    expect(prompt(false)).toContain("judge from the result alone and do not read files");
    expect(prompt(false)).not.toContain("Read the workspace");
  });
});

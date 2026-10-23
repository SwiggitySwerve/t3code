import { describe, expect, it } from "vite-plus/test";

import {
  parseStoredWorkflowScript,
  storedWorkflowScript,
  storedWorkflowScriptSource,
} from "./storedWorkflowScript.ts";

describe("stored workflow scripts", () => {
  it("round-trips the script, args and budget", () => {
    const stored = storedWorkflowScript("return args", { args: { n: 1 }, budgetTokens: 500 });
    expect(parseStoredWorkflowScript(stored)).toEqual({
      source: "return args",
      args: { n: 1 },
      budgetTokens: 500,
    });
  });

  it("keeps a script that itself starts like the settings line", () => {
    const source = "// t3-workflow: not settings\nreturn 1";
    const stored = storedWorkflowScript(source, {});
    expect(parseStoredWorkflowScript(stored)).toEqual({
      source,
      args: null,
      budgetTokens: undefined,
    });
    expect(storedWorkflowScriptSource(stored)).toBe(source);
  });

  it("reads a script stored before the settings line existed", () => {
    expect(storedWorkflowScriptSource("return 1")).toBe("return 1");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { formatComposerContextReference } from "./composerContextReferences.ts";
import {
  detectWorkflowIntent,
  normalizeWorkflowTriggerPhrase,
  personTypedWords,
  WORKFLOW_TRIGGER_PHRASE_MAX_CHARS,
  workflowTriggerExtrasProblems,
} from "./workflowIntent.ts";

const on = (extras: ReadonlyArray<string> = []) => ({ enabled: true, extras });
const keyword = (text: string, extras: ReadonlyArray<string> = []) =>
  detectWorkflowIntent(text, on(extras))?.keyword ?? null;

describe("detectWorkflowIntent", () => {
  it("matches the built-in word as a whole word, in any case, with ordinary punctuation", () => {
    for (const text of [
      "workflow",
      "Run this as a Workflow please",
      "WORKFLOW: split the refactor",
      'use a "workflow", then report',
      "(workflow)",
      "**workflow** first",
      "what is the workflow's output?",
      "start a workflow.",
      "plan a\nworkflow\nnow",
      "a workflow\u2014please",
    ]) {
      expect(keyword(text), text).toBe("workflow");
    }
  });

  it("does not match parts of other words", () => {
    for (const text of ["workflows", "networkflow", "workflowish", "workflow2", "myworkflow"]) {
      expect(keyword(text), text).toBeNull();
    }
  });
  it("skips code, URLs, paths, file names and identifiers", () => {
    for (const text of [
      "call `workflow` directly",
      "```\nworkflow\n```",
      "```\nunclosed fence with workflow",
      "see https://example.com/workflow for details",
      "see https://example.com/?q=workflow",
      "open .github/workflows/ci.yml",
      "open .github/workflow/ci.yml",
      "open src/workflow/index.ts",
      "the workflow_start tool",
      "workflowStart and start_workflow",
      "edit workflow.yml",
      "run ./workflow.sh",
      "pass --workflow to the cli",
      "use @workflow or $workflow",
      "workflow-runner and ci-workflow",
      "workflow()",
      "[workflow](https://example.com)",
    ]) {
      expect(keyword(text), text).toBeNull();
    }
  });

  it("skips fences inside blockquotes and list items, indented code and multiline inline code", () => {
    for (const text of [
      "> ```\n> workflow\n> ```",
      "> ~~~ts\n> const workflow = 1\n> ~~~",
      "- ```\n  workflow\n  ```",
      "1. ```ts\n   const workflow = 1\n   ```",
      "> - ```\n>   workflow\n>   ```",
      "    workflow",
      "\tworkflow",
      "Run this:\n\n    workflow --start\n    more workflow",
      "- item\n\n      workflow indented code in a list item",
      "call `the\nworkflow` tool",
      "call ``the\nworkflow`` tool",
      "> ```\r\n> workflow\r\n> ```",
      "Run this:\r\n\r\n    workflow\r\n",
    ]) {
      expect(keyword(text), text).toBeNull();
    }
  });

  it("keeps a valid occurrence next to these code forms", () => {
    for (const text of [
      "> ```\n> workflow\n> ```\nnow a real workflow",
      "- ```\n  workflow\n  ```\n- plan a workflow",
      "    workflow\n\nplan a workflow",
      "call `the\nworkflow` tool, then plan a workflow",
      // An indented line continues its paragraph; it is not code.
      "plan this\n    workflow now",
      "- plan this\n  workflow now",
      "> plan a workflow",
    ]) {
      expect(keyword(text), text).toBe("workflow");
    }
  });

  it("reads deeply nested Markdown without exhausting the stack", () => {
    const quotes = "> ".repeat(10_000);
    expect(keyword(`${quotes}plan a workflow`)).toBe("workflow");
    expect(keyword(`${quotes}plain words`)).toBeNull();
    // Code at the bottom of the nest is still code; a valid word after the nest still counts.
    expect(keyword(`${quotes}\`workflow\``)).toBeNull();
    expect(keyword(`${quotes}\`workflow\`\n\nplan a workflow`)).toBe("workflow");
  });

  it("skips CI compounds in either direction", () => {
    for (const text of [
      "fix the CI workflow",
      "the GitHub Actions workflow is red",
      "the pipeline workflow",
      "update the build workflow",
      "the release workflow and the deploy workflow",
      "CI/CD workflow",
      "edit the workflow file",
      "a workflow yaml, a workflow yml, a workflow dispatch",
      "check the workflow files.",
    ]) {
      expect(keyword(text), text).toBeNull();
    }
  });

  it("keeps a valid occurrence when another occurrence is excluded", () => {
    for (const text of [
      "fix the CI workflow, then plan a workflow for the refactor",
      "run `workflow` and then start a workflow",
      "see https://example.com/workflow and use a workflow",
      "the workflow_start tool belongs in a workflow",
      "```\nworkflow\n```\nnow a real workflow",
      "plan a workflow, then edit the workflow file",
    ]) {
      expect(keyword(text), text).toBe("workflow");
    }
  });
  it("skips fenced tildes and Windows paths", () => {
    expect(keyword("~~~ts\nconst workflow = 1\n~~~")).toBeNull();
    expect(keyword(String.raw`open C:\repo\workflow\a.ts`)).toBeNull();
  });

  it("ignores context chips and legacy context blocks but keeps the typed words around them", () => {
    const chip = formatComposerContextReference({
      kind: "mention",
      contextId: "ctx-1" as never,
      label: "workflow",
    });
    expect(keyword(`look at ${chip}`)).toBeNull();
    expect(keyword(`look at ${chip} as a workflow`)).toBe("workflow");
    expect(
      keyword(
        "look at this\n\n<terminal_context>\n- build line 1:\n  1 | workflow\n</terminal_context>",
      ),
    ).toBeNull();
  });

  it("reads a person's typed words with chips and legacy context blocks taken out", () => {
    const chip = formatComposerContextReference({
      kind: "mention",
      contextId: "ctx-1" as never,
      label: "ultracode.ts",
    });
    expect(personTypedWords(`look at ${chip} now`)).not.toContain("ultracode");
    expect(personTypedWords(`look at ${chip} now`)).toContain("look at");
    expect(personTypedWords(`look at ${chip} now`)).toContain("now");
    expect(
      personTypedWords(
        "look\n\n<terminal_context>\n- build line 1:\n  1 | ultracode\n</terminal_context>",
      ),
    ).not.toContain("ultracode");
    expect(personTypedWords("plain words")).toBe("plain words");
  });

  it("matches the user's extra words and phrases literally", () => {
    expect(keyword("please orchestrate this", ["orchestrate"])).toBe("orchestrate");
    expect(keyword("Fan   Out the work", ["fan out"])).toBe("fan out");
    expect(keyword("fan outs", ["fan out"])).toBeNull();
    expect(keyword("please fan out.", ["fan out"])).toBe("fan out");
    expect(keyword("use c++, please", ["c++"])).toBe("c++");
    expect(keyword("a plan", ["plan b"])).toBeNull();
  });

  it("never reads a phrase as a pattern", () => {
    for (const extra of [".*", "a|b", "(", "[", "^workflow$", "w.rkflow", "a+"]) {
      expect(() => detectWorkflowIntent("anything at all", on([extra]))).not.toThrow();
    }
    expect(keyword("anything at all", [".*"])).toBeNull();
    expect(keyword("a|b and ab", ["a|b"])).toBe("a|b");
    expect(keyword("wxrkflow", ["w.rkflow"])).toBeNull();
    expect(keyword("w.rkflow", ["w.rkflow"])).toBe("w.rkflow");
  });

  it("applies the exclusions to extra phrases too", () => {
    expect(keyword("call `orchestrate` now", ["orchestrate"])).toBeNull();
    expect(keyword("open src/orchestrate/a.ts", ["orchestrate"])).toBeNull();
    expect(keyword("the orchestrate file", ["orchestrate"])).toBeNull();
    expect(keyword("the orchestrate plan", ["orchestrate"])).toBe("orchestrate");
  });

  it("turns off every word, the built-in one included, when disabled", () => {
    expect(detectWorkflowIntent("a workflow", { enabled: false, extras: [] })).toBeNull();
    expect(
      detectWorkflowIntent("orchestrate", { enabled: false, extras: ["orchestrate"] }),
    ).toBeNull();
  });

  it("keeps the built-in word when extras are empty or blank", () => {
    expect(keyword("a workflow", [])).toBe("workflow");
    expect(keyword("a workflow", ["", "  "])).toBe("workflow");
    expect(detectWorkflowIntent("a workflow")?.keyword).toBe("workflow");
  });
});

describe("detectWorkflowIntent without a trigger word", () => {
  // These texts skip the Markdown parse, so only the answer is checked: it must stay the same
  // as the full scan's, and a text that holds a trigger's first word must still be scanned.
  it("finds nothing when no trigger's first word is present", () => {
    for (const text of ["", " ", "plan the audit", "- item\n- another", "work flow"]) {
      expect(keyword(text), text).toBeNull();
      expect(keyword(text, ["fan out", ""]), text).toBeNull();
    }
  });

  it("still finds the built-in word and extras in any case, with or without extras", () => {
    expect(keyword("Plan a WORKFLOW")).toBe("workflow");
    expect(keyword("Plan a WORKFLOW", [])).toBe("workflow");
    expect(keyword("Please FAN OUT the audit", ["fan out"])).toBe("fan out");
    expect(keyword("please fan out", ["  Fan   Out "])).toBe("Fan   Out");
    expect(keyword("a workflow, please fan out", ["fan out"])).toBe("workflow");
    expect(keyword("please fan out", ["", "  ", "fan out"])).toBe("fan out");
  });

  it("scans a text that holds only the first word of a longer phrase", () => {
    expect(keyword("fan the flames", ["fan out"])).toBeNull();
    expect(keyword("fan out", ["fan out"])).toBe("fan out");
  });

  it("still masks code when the trigger's first word is only inside it", () => {
    expect(keyword("run `workflow` here")).toBeNull();
    expect(keyword("run `fan out` here", ["fan out"])).toBeNull();
  });

  it("matches a word-final sigma that only becomes final once code is masked", () => {
    // Whole-text lowercasing reads the sigma as medial because of the code after it.
    expect(keyword("\u0391\u03a3`x`", ["\u03b1\u03c2"])).toBe("\u03b1\u03c2");
  });
});

describe("workflowTriggerExtrasProblems", () => {
  it("accepts distinct, short phrases", () => {
    expect(workflowTriggerExtrasProblems(["orchestrate", "fan out"])).toEqual([]);
  });

  it("refuses blanks, long phrases and duplicates, including the built-in word", () => {
    const long = "x".repeat(WORKFLOW_TRIGGER_PHRASE_MAX_CHARS + 1);
    expect(workflowTriggerExtrasProblems(["  "])).toHaveLength(1);
    expect(workflowTriggerExtrasProblems([long])).toHaveLength(1);
    expect(workflowTriggerExtrasProblems([long.slice(1)])).toEqual([]);
    expect(workflowTriggerExtrasProblems(["Fan out", "fan   OUT"])).toHaveLength(1);
    expect(workflowTriggerExtrasProblems(["Workflow"])).toEqual([
      '"workflow" is always a trigger.',
    ]);
  });

  it("uses the comparison form the detector uses", () => {
    expect(normalizeWorkflowTriggerPhrase("  Fan   Out ")).toBe("fan out");
  });
});

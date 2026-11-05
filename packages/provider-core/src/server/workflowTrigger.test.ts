import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { WorkflowTriggers } from "@t3tools/contracts/settings";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { detectWorkflowIntent } from "@t3tools/shared/workflowIntent";

import {
  applyTurnTriggers,
  CLAUDE_NATIVE_ORCHESTRATION_KEYWORD,
  EVERY_TURN_WORKFLOW_NOTE,
  workflowRequestOf,
  workflowTurnNote,
} from "./workflowTrigger.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const cursor = ProviderDriverKind.make("cursor");

const noExtras: WorkflowTriggers = { extras: [] };
const everyTurnNote = `\n\n${EVERY_TURN_WORKFLOW_NOTE}`;

const person = {
  createdBy: "user",
  creationSource: "web",
  delegatedThread: false,
  resumesEarlierTurn: false,
} as const;

function turn(
  text: string,
  overrides: Partial<Parameters<typeof applyTurnTriggers>[0]> = {},
): string {
  return applyTurnTriggers({
    workflows: true,
    workflowStart: "keyword",
    workflowTriggers: noExtras,
    driver: codex,
    text,
    typedText: text,
    ...person,
    ...overrides,
  });
}

const isWorkflowTurn = (result: string) => result.includes("<t3-workflow>");

describe("applyTurnTriggers", () => {
  it("suppresses workflow and every-turn guidance while workflows are off", () => {
    for (const driver of [codex, claude, cursor]) {
      for (const text of ["run a workflow", "Audit this"]) {
        expect(turn(text, { workflows: false, workflowStart: "always", driver })).toBe(text);
        expect(
          workflowRequestOf({
            ...person,
            workflows: false,
            workflowStart: "always",
            workflowTriggers: noExtras,
            typedText: text,
          }),
        ).toBe("ignored");
      }
    }
  });

  it("adds the same plan-first note on every driver, without a native trigger word", () => {
    const notes = [codex, claude, cursor].map((driver) =>
      turn("Split this into a workflow", { driver }).replace("Split this into a workflow", ""),
    );
    expect(new Set(notes).size).toBe(1);
    const [note] = notes;
    expect(note).toContain("graph_review");
    expect(note).not.toContain(CLAUDE_NATIVE_ORCHESTRATION_KEYWORD);
    // The turn text is untouched ahead of the note: nothing is appended to the user's words.
    expect(turn("Split this into a workflow", { driver: claude })).toMatch(
      /^Split this into a workflow\n\n<t3-workflow>/u,
    );
  });

  it("plans first and does not tell the agent to start a script", () => {
    const note = workflowTurnNote();
    expect(note).toContain("graph_review");
    expect(note).toContain("The user approves it in T3 Code");
    expect(note).toContain("do not call graph_start or workflow_start before that message");
    // A review that needs no approval must not leave the coordinator waiting for one.
    expect(note).toContain("When graph_review returns approvalRequired: true, end your turn.");
    expect(note).toContain("When it returns false, call graph_start.");
  });

  it("leaves every assignment to the coordinator and asks for a cross-family check", () => {
    for (const note of [workflowTurnNote(), EVERY_TURN_WORKFLOW_NOTE]) {
      expect(note).toContain("every worker's and every check's target");
      expect(note).toContain("from orchestrator_capabilities. Never invent ids.");
      expect(note).toContain(
        "Give each agent the smallest model and effort you expect to succeed first time (pass its check, if it has one)",
      );
      expect(note).toContain("Prefer lowering effort to switching to a much weaker model");
      expect(note).toContain("run a planning agent on a stronger model first");
      expect(note).toContain("different model family than its worker");
      expect(note).toContain("{ type: 'judgment', rubric, target }");
      // E4: visible-test checks passed wrong work, so the ladder never escalated.
      expect(note).toContain("tests its worker can see or wrote are not enough alone");
      expect(note).toContain("{ type: 'process', argv } the worker cannot have tuned to");
      expect(note).toContain("A judge needs no stronger model than the work: prefer a cheap one");
      expect(note).toContain(
        "Give an agent with a check that can fail it retries: later targets, cheapest first, then more effort or model.",
      );
      expect(note).toContain("Redo it only once they run out or the split was wrong.");
      expect(note).toContain(
        "listPrice is the provider's published price, not what this account pays; null is unknown, not free.",
      );
      expect(note).not.toMatch(/preset|profile|Settings/iu);
    }
  });

  it("plans a requested workflow instead of the every-turn note, on every driver", () => {
    for (const driver of [codex, claude, cursor]) {
      for (const workflowStart of ["keyword", "always"] as const) {
        const result = turn("run this as a workflow", { driver, workflowStart });
        expect(isWorkflowTurn(result), driver).toBe(true);
        expect(result).not.toContain(EVERY_TURN_WORKFLOW_NOTE);
        expect(result.endsWith(`\n${CLAUDE_NATIVE_ORCHESTRATION_KEYWORD}`)).toBe(false);
      }
    }
  });

  it("leaves a plain message alone in keyword mode", () => {
    for (const driver of [codex, claude, cursor]) {
      expect(turn("Audit this", { driver }), driver).toBe("Audit this");
    }
  });

  it("runs every other person-typed turn as a workflow under always", () => {
    for (const driver of [codex, cursor]) {
      expect(turn("Audit this", { workflowStart: "always", driver }), driver).toBe(
        `Audit this${everyTurnNote}`,
      );
    }
    // Claude gets Claude Code's own trigger instead, in the provider text only.
    expect(turn("Audit this", { workflowStart: "always", driver: claude })).toBe(
      `Audit this\n\n${CLAUDE_NATIVE_ORCHESTRATION_KEYWORD}`,
    );
    expect(EVERY_TURN_WORKFLOW_NOTE).toContain("workflow_start");
    expect(EVERY_TURN_WORKFLOW_NOTE).not.toContain(CLAUDE_NATIVE_ORCHESTRATION_KEYWORD);
  });

  it("never starts a workflow from a message when off", () => {
    const workflowTriggers = { extras: ["fan out"] };
    for (const driver of [codex, claude, cursor]) {
      for (const text of ["run this as a workflow", "please fan out", "Audit this"]) {
        expect(
          turn(text, { driver, workflowStart: "off", workflowTriggers }),
          `${driver} ${text}`,
        ).toBe(text);
      }
    }
  });

  it.each(["keyword", "always"] as const)(
    "never opts a delegated thread in under %s, whoever wrote the message",
    (workflowStart) => {
      const child = { delegatedThread: true, workflowStart } as const;
      for (const driver of [codex, claude, cursor]) {
        for (const text of ["Scan a.ts as a workflow", "Go on"]) {
          // A person writing to the child, the task text its agent wrote, and a parent's answer.
          expect(turn(text, { ...child, driver }), driver).toBe(text);
          expect(turn(text, { ...child, driver, createdBy: "agent", creationSource: "mcp" })).toBe(
            text,
          );
          expect(turn(text, { ...child, driver, creationSource: "server" })).toBe(text);
        }
      }
    },
  );

  it("reads the typed text, not the provider text", () => {
    // A context chip's contents are in the provider text; only what the person typed counts.
    const providerText = "Look at this\n\n<t3_context>the workflow log</t3_context>";
    expect(turn(providerText, { typedText: "Look at this" })).toBe(providerText);
    // The typed word still asks, and the note follows the projected text.
    expect(turn(providerText, { typedText: "Look at this workflow" })).toMatch(
      /^Look at this\n\n<t3_context>the workflow log<\/t3_context>\n\n<t3-workflow>/u,
    );
    // A chip's label is not a typed word: a file called workflow.log must not ask for one.
    const chip = formatComposerContextReference({
      kind: "terminal",
      contextId: "ctx-log" as never,
      label: "workflow.log",
    });
    expect(turn(`Look at ${chip}`)).toBe(`Look at ${chip}`);
  });

  it("uses the person's extra words", () => {
    const workflowTriggers = { extras: ["fan out"] };
    expect(isWorkflowTurn(turn("please fan out the audit", { workflowTriggers }))).toBe(true);
    expect(turn("please fan in the audit", { workflowTriggers })).toBe("please fan in the audit");
  });

  it("starts only from a person's message on a thread that is not a delegated task", () => {
    const refused: ReadonlyArray<Partial<Parameters<typeof applyTurnTriggers>[0]>> = [
      { createdBy: "agent", creationSource: "mcp" },
      { createdBy: "agent", creationSource: "provider" },
      { createdBy: "agent", creationSource: "server" },
      { createdBy: "system", creationSource: "server" },
      // A completion wake, a canned reply or a parent's answer is made by the server.
      { createdBy: "user", creationSource: "server" },
      { createdBy: "user", creationSource: "mcp" },
      { createdBy: "user", creationSource: "web", scheduledTaskId: "task-1" },
      { createdBy: "user", creationSource: "mobile", senderThreadId: "thread-1" },
      { delegatedThread: true },
      // A steering restart or a restart continuation resumes work; it is not a new request.
      { resumesEarlierTurn: true },
    ];
    // Neither the plan-first note nor, under always, the every-turn note or Claude's keyword.
    for (const overrides of refused) {
      for (const workflowStart of ["keyword", "always"] as const) {
        for (const driver of [codex, claude]) {
          for (const text of ["plan a workflow", "Audit this"]) {
            expect(
              turn(text, { workflowStart, driver, ...overrides }),
              `${workflowStart} ${driver} ${JSON.stringify(overrides)}`,
            ).toBe(text);
          }
        }
      }
    }
    expect(isWorkflowTurn(turn("plan a workflow", { creationSource: "mobile" }))).toBe(true);
  });

  it.each([codex, claude])(
    "leaves server-created workflow approvals unchanged for %s",
    (driver) => {
      const text = "The workflow is approved. Use graph_start with the accepted digest.";
      for (const workflowStart of ["always", "keyword"] as const) {
        for (const createdBy of ["user", "system"] as const) {
          expect(turn(text, { workflowStart, driver, createdBy, creationSource: "server" })).toBe(
            text,
          );
        }
      }
    },
  );

  it("asks for a workflow exactly when the shared detector does, slash text included", () => {
    // The composer chip uses the same detector, so the server adds no exception of its own.
    // How per-turn notes meet a native command's text is a wider, existing concern.
    for (const text of [
      "/goal ship the workflow engine",
      "  /review the workflow notes",
      "/src/parser.ts needs a workflow",
      "run a workflow /goal",
      "/goal ship it",
      "/deploy.prod plan the workflow",
      "/review `workflow`",
    ]) {
      expect(isWorkflowTurn(turn(text)), text).toBe(detectWorkflowIntent(text, noExtras) !== null);
    }
    expect(isWorkflowTurn(turn("/goal ship the workflow engine"))).toBe(true);
    expect(isWorkflowTurn(turn("/goal ship it"))).toBe(false);
  });
});

describe("workflowTurnNote", () => {
  it("names no model, so the coordinator picks from what is enabled", () => {
    expect(workflowTurnNote()).not.toMatch(/gemini|claude|codex|opus|sonnet|haiku/iu);
  });

  it("is compact", () => {
    expect(workflowTurnNote().length).toBeLessThan(1700);
    expect(EVERY_TURN_WORKFLOW_NOTE.length).toBeLessThan(1550);
  });
});

describe("workflowRequestOf", () => {
  const ask = (overrides: Partial<Parameters<typeof workflowRequestOf>[0]> = {}) =>
    workflowRequestOf({
      workflowStart: "keyword",
      workflowTriggers: noExtras,
      typedText: "Split this into a workflow",
      ...person,
      ...overrides,
    });

  it("tells a person's request from a plain message and from what is not theirs to ask", () => {
    expect(ask()).toBe("requested");
    expect(ask({ typedText: "Audit the parser" })).toBe("plain");
    expect(ask({ creationSource: "mobile" })).toBe("requested");
    for (const overrides of [
      { createdBy: "agent", creationSource: "mcp" },
      { createdBy: "agent", creationSource: "provider" },
      { createdBy: "agent", creationSource: "server" },
      { createdBy: "system", creationSource: "server" },
      // The canned message the server sends when the user decides on a review.
      { createdBy: "user", creationSource: "server" },
      // Each of these alone is enough: a schedule or another thread typed nothing.
      { scheduledTaskId: "task-1" },
      { senderThreadId: "thread-1" },
      { delegatedThread: true },
      { resumesEarlierTurn: true },
    ] as const) {
      expect(ask(overrides), JSON.stringify(overrides)).toBe("ignored");
      // Ignored even for words that are not a request, so a plain agent message lifts nothing.
      expect(ask({ ...overrides, typedText: "Audit the parser" })).toBe("ignored");
    }
  });

  it("follows the workflowStart setting and the trigger extras", () => {
    const workflowTriggers = { extras: ["fan out"] };
    for (const workflowStart of ["keyword", "always"] as const) {
      expect(ask({ workflowStart })).toBe("requested");
      expect(ask({ workflowStart, workflowTriggers, typedText: "please fan out the audit" })).toBe(
        "requested",
      );
    }
    // Off reads every person's message as plain, so a new one still lifts a waiting request.
    expect(ask({ workflowStart: "off" })).toBe("plain");
    expect(ask({ workflowStart: "off", workflowTriggers, typedText: "please fan out" })).toBe(
      "plain",
    );
    // What is not a person's new request stays ignored whatever the setting.
    expect(ask({ workflowStart: "off", createdBy: "agent", creationSource: "mcp" })).toBe(
      "ignored",
    );
  });

  it("is the answer applyTurnTriggers uses, and it uses a given answer without asking again", () => {
    const text = "plan a workflow";
    const input = {
      workflowStart: "keyword",
      workflowTriggers: noExtras,
      driver: codex,
      text,
      typedText: text,
      ...person,
    } as const;
    expect(isWorkflowTurn(applyTurnTriggers(input))).toBe(true);
    expect(isWorkflowTurn(applyTurnTriggers(input, "requested"))).toBe(true);
    // The caller asked once already; a different answer is the caller's, not a second reading.
    expect(applyTurnTriggers(input, "plain")).toBe(text);
    expect(applyTurnTriggers(input, "ignored")).toBe(text);
    // Under always only a plain answer gets the every-turn note; an ignored one never does.
    const always = { ...input, workflowStart: "always" } as const;
    expect(applyTurnTriggers(always, "plain")).toBe(text + everyTurnNote);
    expect(applyTurnTriggers(always, "ignored")).toBe(text);
  });
});

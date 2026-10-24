export const scenarios = ["review", "refactor", "unavailable", "restart"] as const;
export type Scenario = (typeof scenarios)[number];

export const coordinator = { providerInstanceId: "cliproxy", model: "gpt-6-astra" };
export const worker = {
  providerInstanceId: "cliproxy",
  model: "gpt-6.1-sol",
  options: [
    // GPT-6.1 Sol on its normal tier; the ultrafast tier is no longer available.
    { id: "serviceTier", value: "default" },
    { id: "reasoningEffort", value: "high" },
  ],
};
export const judge = { providerInstanceId: "cliproxy", model: "claude-opus-5-5" };
export const secondProvider = { providerInstanceId: "claudeproxy", model: "claude-opus-5-5" };

const reviewFiles = {
  "src/greeting.cjs":
    'const { execSync } = require("node:child_process");\nexports.greet = (name) => execSync("echo " + name).toString();\n',
  "src/price.cjs":
    "// Return the total price including twenty percent tax.\nexports.total = (subtotal) => subtotal * 0.2;\n",
  "test/price.test.cjs":
    'const assert = require("node:assert/strict");\nconst { total } = require("../src/price.cjs");\nassert.equal(total(100), total(100));\n',
};

export const defects = [
  {
    id: "security",
    path: "src/greeting.cjs",
    line: 2,
    quote: 'execSync("echo " + name)',
    consequence: /shell|command|injection/i,
  },
  {
    id: "correctness",
    path: "src/price.cjs",
    line: 2,
    quote: "subtotal * 0.2",
    consequence:
      /\b120\b|\b1\.2\b|\bonly\b.{0,20}\btax\b|\btax\b.{0,20}\bonly\b|\btax amount\b|\btax\b.{0,30}\b(?:instead of|rather than)\b/i,
  },
  {
    id: "tests",
    path: "test/price.test.cjs",
    line: 3,
    quote: "assert.equal(total(100), total(100))",
    consequence:
      /\bsame\b|\bitself\b|tautolog|\bno expected\b|\bidentical\b|\balways pass|\bnever (?:fail|checks? (?:the )?expected)\b/i,
  },
] as const;

const refactorFiles = {
  "src/label.mjs": "export const oldLabel = (name) => `Hello, ${name}!`;\n",
  "src/first.mjs":
    'import { oldLabel } from "./label.mjs";\nexport const first = () => oldLabel("Ada");\n',
  "src/second.mjs":
    'import { oldLabel } from "./label.mjs";\nexport const second = () => oldLabel("Lin");\n',
  "test/behavior.mjs":
    'import assert from "node:assert/strict";\nimport { first } from "../src/first.mjs";\nimport { second } from "../src/second.mjs";\nassert.equal(first(), "Hello, Ada!");\nassert.equal(second(), "Hello, Lin!");\n',
  "writes.log": "",
};

export function fixtureFiles(scenario: Scenario): Record<string, string> {
  return scenario === "review" || scenario === "unavailable"
    ? { ...reviewFiles }
    : { ...refactorFiles };
}

export function expectedFiles(scenario: Scenario): Record<string, string> {
  const files = fixtureFiles(scenario);
  if (scenario === "refactor" || scenario === "restart") {
    for (const path of ["src/label.mjs", "src/first.mjs", "src/second.mjs"]) {
      files[path] = files[path]!.replaceAll("oldLabel", "newLabel");
    }
    files["writes.log"] = "writer\n";
  }
  return files;
}

export interface AcceptanceNode {
  subject: string;
  description: string;
  dependsOn: string[];
  target: typeof coordinator | typeof worker;
  scopes: { read: string[]; write: string[] };
  attemptBudget: "short";
  verify?:
    | { type: "process"; argv: string[]; timeoutMs: number }
    | { type: "judgment"; target: typeof judge; rubric: string[] };
}

export function acceptanceGraph(scenario: Scenario, processCheck: string[], gateCheck: string[]) {
  const node = (
    subject: string,
    description: string,
    dependsOn: string[] = [],
    write: string[] = [],
  ): AcceptanceNode => ({
    subject,
    description,
    dependsOn,
    target: worker,
    scopes: { read: ["src", "test", "writes.log"], write },
    attemptBudget: "short",
  });
  let nodes: Record<string, AcceptanceNode>;
  if (scenario === "review") {
    nodes = Object.fromEntries(
      defects.map((defect) => [
        defect.id,
        node(
          `Review ${defect.id}`,
          `Review the ${defect.id} of this fixture. Read source and tests; do not execute the unsafe greeting. Do not write any file. Return ONLY JSON, at most 1200 characters, with exactly one finding and no extra fields: {"findings":[{"id":"${defect.id}","path":"relative/path","line":1,"quote":"exact source substring","explanation":"the concrete defect and its consequence"}]}. Cite the actual defective line, not the comment.`,
        ),
      ]),
    );
  } else if (scenario === "unavailable") {
    nodes = {
      missingProvider: {
        ...node("Unavailable provider", "Do not write files. Reply done."),
        target: { providerInstanceId: "acceptance-provider-does-not-exist", model: worker.model },
      },
      unknownModel: {
        ...node("Unknown model", "Do not write files. Reply done."),
        target: { providerInstanceId: "cliproxy", model: "acceptance-model-does-not-exist" },
      },
    };
  } else {
    nodes = {
      scoutA: node(
        "Scout definitions",
        "Read src/label.mjs. Identify the exported symbol and the exact behavior to preserve. Do not write files.",
      ),
      scoutB: node(
        "Scout consumers",
        "Read src/first.mjs, src/second.mjs and test/behavior.mjs. Identify every consumer to update. Do not write files.",
      ),
      ...(scenario === "restart"
        ? {
            cross: {
              ...node(
                "Cross-provider review",
                "Read the fixture and describe the compatibility constraint in one sentence. Do not write files.",
              ),
              target: secondProvider,
            },
          }
        : {}),
      writer: {
        ...node(
          "Rename public symbol",
          "Rename oldLabel to newLabel in exactly src/label.mjs, src/first.mjs and src/second.mjs, preserving all other bytes and behavior. Append exactly writer followed by one newline to writes.log ONCE. Do not change tests or any other file. Use in-place writes: temporary files, atomic-save renames and directory changes are outside this acceptance scenario's allowed writes and will fail its filesystem audit even if later removed. Do not delegate. Run node test/behavior.mjs.",
          scenario === "restart" ? ["scoutA", "scoutB", "cross"] : ["scoutA", "scoutB"],
          ["src/label.mjs", "src/first.mjs", "src/second.mjs", "writes.log"],
        ),
        verify: { type: "process", argv: processCheck, timeoutMs: 120000 },
      },
      audit: {
        ...node(
          "Independent audit",
          "Read all source and tests and writes.log. Verify the rename is complete, behavior unchanged, tests unchanged and the log has exactly one writer line. Run node test/behavior.mjs. Do not write files. Give evidence with file paths and commands.",
          ["writer"],
        ),
        verify: {
          type: "judgment",
          target: judge,
          rubric: [
            "Read the fixture independently; do not write files.",
            "All three source modules use newLabel, the behavior tests are unchanged and pass, and writes.log contains exactly one writer line.",
            "The audit cites concrete file and process evidence.",
          ],
        },
      },
    };
    if (scenario === "restart") {
      nodes.scoutB!.verify = { type: "process", argv: gateCheck, timeoutMs: 900000 };
    }
  }
  return { schemaVersion: 1 as const, name: `Acceptance: ${scenario}`, nodes };
}

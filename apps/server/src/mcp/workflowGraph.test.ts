import { describe, expect, it } from "@effect/vitest";
import { OrchestratorMcpGraphReviewInput } from "@t3tools/contracts";

import { attemptBudgetMs, GRAPH_DRIVER_SCRIPT, parseGraph, reviewGraph } from "./workflowGraph.ts";
import { runWorkflowScript, type WorkflowScriptHost } from "./workflowScript.ts";

const HASH = "a".repeat(64);
const NEXT_HASH = "b".repeat(64);
const node = (overrides: Record<string, unknown> = {}) => ({
  subject: "Task",
  description: "Do the task",
  dependsOn: [],
  ...overrides,
});
const graph = (nodes: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  nodes,
  ...overrides,
});
const normalized = (value: unknown) => {
  const parsed = parseGraph(value);
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return parsed.graph;
};
const problems = (value: unknown) => {
  const parsed = parseGraph(value);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? "" : parsed.problems.join("\n");
};

describe("graph parsing", () => {
  it("normalizes shared paths, defaults, scopes and checks", () => {
    const parsed = normalized(
      graph(
        {
          build: node({
            inputs: [{ id: "source", kind: "workspace_snapshot", path: ".\\src\\main.ts" }],
            outputs: [{ id: "report", path: "./out/report.json" }],
            scopes: { read: ["./src", "src"], write: ["out"] },
            verify: { type: "structured", outputId: "report" },
          }),
        },
        { name: " Build " },
      ),
    );
    expect(parsed.name).toBe("Build");
    expect(parsed.nodes.build).toMatchObject({
      attemptBudget: "standard",
      dependsOn: [],
      inputs: [{ id: "source", kind: "workspace_snapshot", path: "src/main.ts", maxBytes: 262144 }],
      outputs: [{ id: "report", path: "out/report.json", maxBytes: 262144 }],
      scopes: { read: ["src"], write: ["out"] },
      verify: { type: "structured", outputId: "report", requiredPointers: [], equals: {} },
    });
  });

  it.each([null, [], 1, "graph"])("rejects a non-object graph: %j", (value) => {
    expect(problems(value)).toContain("graph must be an object");
  });

  it("rejects an unsupported schema and empty or non-map nodes", () => {
    expect(problems(graph({ a: node() }, { schemaVersion: 2 }))).toContain("schemaVersion");
    expect(problems(graph({}))).toContain("non-empty map");
    expect(problems({ schemaVersion: 1, nodes: [] })).toContain("non-empty map");
  });

  it.each(["bad id", "-bad", "a".repeat(65)])("rejects a bad node id: %s", (key) => {
    expect(problems(graph({ [key]: node() }))).toContain("needs an id");
  });

  it.each([
    { subject: "" },
    { description: 1 },
    { dependsOn: "a" },
    { dependsOn: ["bad id"] },
    { phase: false },
    { role: "" },
    { stallTimeoutMs: 0 },
    { stallTimeoutMs: 60000.1 },
    { attemptBudget: "forever" },
    { longBudgetApproved: false },
  ])("rejects malformed node fields: %j", (fields) => {
    expect(problems(graph({ a: node(fields) }))).toBeTruthy();
  });

  it("reports unknown dependencies", () => {
    expect(problems(graph({ a: node({ dependsOn: ["absent"] }) }))).toContain(
      "unknown dependsOn node absent",
    );
  });

  it("names dependency cycles, including self-dependencies", () => {
    expect(
      problems(
        graph({
          a: node({ dependsOn: ["b"] }),
          b: node({ dependsOn: ["c"] }),
          c: node({ dependsOn: ["a"] }),
        }),
      ),
    ).toContain("a -> b -> c -> a");
    expect(problems(graph({ a: node({ dependsOn: ["a"] }) }))).toContain("a -> a");
  });

  it("requires a task_output producer to be a direct dependency", () => {
    expect(
      problems(
        graph({
          a: node({ outputs: [{ id: "data", path: "data.json" }] }),
          b: node({ inputs: [{ id: "data", kind: "task_output", nodeId: "a", outputId: "data" }] }),
        }),
      ),
    ).toContain("producer a is not in dependsOn");
  });

  it("requires task_output references to name declared producer outputs", () => {
    expect(
      problems(
        graph({
          a: node(),
          b: node({
            dependsOn: ["a"],
            inputs: [{ id: "data", kind: "task_output", nodeId: "a", outputId: "missing" }],
          }),
        }),
      ),
    ).toContain("undeclared output a.missing");
    expect(
      problems(
        graph({
          b: node({
            dependsOn: ["a"],
            inputs: [{ id: "data", kind: "task_output", nodeId: "a", outputId: "data" }],
          }),
        }),
      ),
    ).toContain("undeclared output a.data");
  });

  it.each(["../escape", "/absolute", "C:\\absolute", "\\\\server\\share", "src/../escape"])(
    "rejects unsafe paths: %s",
    (path) => {
      for (const fields of [
        { inputs: [{ id: "source", kind: "workspace_snapshot", path }] },
        { outputs: [{ id: "report", path }] },
        { scopes: { write: [path] } },
        { verify: { type: "process", argv: ["node"], cwd: path } },
      ])
        expect(problems(graph({ a: node(fields) }))).toMatch(/workspace/);
    },
  );

  it("rejects duplicate input and output ids across input kinds", () => {
    expect(
      problems(
        graph({
          a: node({
            inputs: [
              { id: "same", kind: "workspace_snapshot", path: "a" },
              { id: "same", kind: "task_output", nodeId: "b", outputId: "b" },
            ],
          }),
        }),
      ),
    ).toContain("inputs ids must be unique");
    expect(
      problems(
        graph({
          a: node({
            outputs: [
              { id: "same", path: "a" },
              { id: "same", path: "b" },
            ],
          }),
        }),
      ),
    ).toContain("outputs ids must be unique");
  });

  it.each([
    { inputs: [{ id: "bad id", kind: "workspace_snapshot", path: "a" }] },
    { inputs: [{ id: "source", kind: "other", path: "a" }] },
    { inputs: [{ id: "source", kind: "task_output", nodeId: "bad id", outputId: "x" }] },
    { inputs: [{ id: "source", kind: "task_output", nodeId: "a", outputId: "bad id" }] },
    { inputs: [{ id: "source", kind: "workspace_snapshot", path: "a", maxBytes: 0 }] },
    { outputs: [{ id: "bad id", path: "a" }] },
    { outputs: [{ id: "out", path: "a", maxBytes: 16 * 1024 * 1024 + 1 }] },
  ])("rejects malformed file contracts: %j", (fields) => {
    expect(problems(graph({ a: node(fields) }))).toBeTruthy();
  });

  it("applies shared file capacity limits to task outputs too", () => {
    const inputs = Array.from({ length: 33 }, (_, index) => ({
      id: "input" + index,
      kind: "task_output",
      nodeId: "producer",
      outputId: "data",
    }));
    expect(problems(graph({ consumer: node({ inputs }) }))).toContain("at most 32 files");
  });

  it("requires explicit approval of the long attempt budget", () => {
    expect(problems(graph({ a: node({ attemptBudget: "long" }) }))).toContain(
      "requires longBudgetApproved: true",
    );
    expect(
      normalized(graph({ a: node({ attemptBudget: "long", longBudgetApproved: true }) })).nodes.a
        ?.attemptBudget,
    ).toBe("long");
  });

  it("rejects duplicate output paths after normalization", () => {
    expect(
      problems(
        graph({
          a: node({ outputs: [{ id: "one", path: "out/result" }] }),
          b: node({ outputs: [{ id: "two", path: ".\\out\\result" }] }),
        }),
      ),
    ).toContain("output path out/result is also declared by a");
  });

  it.each([
    { verify: {} },
    { verify: { type: "process", argv: [] } },
    { verify: { type: "structured", requiredPointers: ["invalid"] } },
    { verify: { type: "judgment", rubric: [] } },
    { scopes: [] },
    { scopes: { write: "src" } },
  ])("reuses verification and scope validation: %j", (fields) => {
    expect(problems(graph({ a: node(fields) }))).toMatch(
      /verify|structured check|JSON pointer|scopes/,
    );
  });

  it("requires structured file verification to name a declared output", () => {
    expect(
      problems(graph({ a: node({ verify: { type: "structured", outputId: "missing" } }) })),
    ).toContain("verify.outputId names an undeclared output");
  });

  it("collects independent problems across nodes", () => {
    const parsed = parseGraph(
      graph({
        "bad id": node(),
        broken: node({ verify: {} }),
        unknown: node({ dependsOn: ["missing"] }),
      }),
    );
    expect(parsed.ok ? [] : parsed.problems).toHaveLength(3);
  });

  it("reports every problem of a graph in one pass, so one review shows what to fix", () => {
    const parsed = parseGraph(
      graph(
        {
          a: node({ subject: "", description: 1, dependsOn: "a", attemptBudget: "forever" }),
          b: node({
            inputs: [
              { id: "i1", kind: "bogus", path: "x" },
              { kind: "workspace_snapshot", path: "y" },
              { id: "i3", kind: "workspace_snapshot", path: "z", maxBytes: -1 },
            ],
            outputs: [{ id: "o1" }, { id: "o2", path: "out/o2.json" }],
          }),
          c: node({ dependsOn: ["absent"] }),
          d: node({
            outputs: [{ id: "o", path: "out/d.json" }],
            verify: { type: "structured", outputId: "missing" },
          }),
        },
        { schemaVersion: 2, name: "" },
      ),
    );
    expect(parsed.ok).toBe(false);
    const found = parsed.ok ? [] : parsed.problems;
    for (const expected of [
      "schemaVersion must be 1",
      "name must be a non-empty string",
      "a: dependsOn must be an array",
      "a: subject must be a non-empty string",
      "a: description must be a non-empty string",
      "a: attemptBudget must be",
      "b: inputs[0]",
      "b: inputs[1]",
      "b: inputs.i3.maxBytes",
      "b: outputs.o1 needs a path",
      "d: verify.outputId names an undeclared output: missing",
      "c: unknown dependsOn node absent",
    ]) {
      expect(
        found.some((problem) => problem.includes(expected)),
        `${expected}\n${found.join("\n")}`,
      ).toBe(true);
    }
  });

  it("does not blame a node for an output of a node that failed to parse", () => {
    const parsed = parseGraph(
      graph({
        producer: node({ subject: "" }),
        consumer: node({
          dependsOn: ["producer"],
          inputs: [{ id: "in", kind: "task_output", nodeId: "producer", outputId: "report" }],
        }),
      }),
    );
    expect(parsed.ok ? [] : parsed.problems).toEqual([
      "producer: subject must be a non-empty string.",
    ]);
  });

  it("carries one complete valid example in the graph description", () => {
    const description = String(
      OrchestratorMcpGraphReviewInput.fields.graph.ast.annotations?.description ?? "",
    );
    const marker = "Complete valid example: ";
    const at = description.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const sample = description.slice(at + marker.length).split("\n")[0]!;
    // Small: the example is about 0.6 KB on top of the description.
    expect(Buffer.byteLength(sample, "utf8")).toBeLessThanOrEqual(700);
    const example: unknown = JSON.parse(sample);
    const review = reviewGraph(example, {
      "src/index.ts": { sha256: HASH, sizeBytes: 1200 },
    });
    expect(review.blockers).toEqual([]);
    expect(review.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(review.layers).toEqual([["scan"], ["summary"]]);
  });
});

describe("graph review", () => {
  it("orders topological layers deterministically", () => {
    const value = graph({
      z: node({ dependsOn: ["b", "a"] }),
      b: node(),
      final: node({ dependsOn: ["z"] }),
      a: node(),
    });
    expect(reviewGraph(value, {}).layers).toEqual([["a", "b"], ["z"], ["final"]]);
  });

  it("reports write conflicts between nodes with no path between them", () => {
    const value = graph({
      a: node({ scopes: { write: ["src", "other"] } }),
      b: node({ outputs: [{ id: "result", path: "src/result.json" }] }),
      c: node({ scopes: { write: ["src2"] } }),
      d: node({ dependsOn: ["a"], scopes: { write: ["src"] } }),
    });
    // d follows a, so only b runs alongside either of them.
    expect(reviewGraph(value, {}).writeConflicts).toEqual([
      { nodes: ["a", "b"], paths: ["src", "src/result.json"] },
      { nodes: ["b", "d"], paths: ["src", "src/result.json"] },
    ]);
  });

  it("treats the workspace root as overlapping every write", () => {
    expect(
      reviewGraph(
        graph({
          a: node({ scopes: { write: ["."] } }),
          b: node({ scopes: { write: ["elsewhere"] } }),
        }),
        {},
      ).writeConflicts,
    ).toEqual([{ nodes: ["a", "b"], paths: [".", "elsewhere"] }]);
  });

  it("reports missing, too-large and over-bound snapshots", () => {
    const value = graph({
      a: node({
        inputs: [
          { id: "absent", kind: "workspace_snapshot", path: "absent" },
          { id: "large", kind: "workspace_snapshot", path: "large" },
          { id: "bounded", kind: "workspace_snapshot", path: "bounded", maxBytes: 1 },
        ],
      }),
    });
    const reviewed = reviewGraph(value, {
      large: "too_large",
      bounded: { sha256: HASH, sizeBytes: 2 },
    });
    expect(reviewed.blockers).toHaveLength(3);
    expect(reviewed.blockers.join("\n")).toMatch(/absent.*missing/);
    expect(reviewed.inputs).toEqual({
      absent: "missing",
      large: "too_large",
      bounded: { sha256: HASH, sizeBytes: 2 },
    });
    expect(
      reviewGraph(value, {
        absent: "missing",
        large: "too_large",
        bounded: { sha256: HASH, sizeBytes: 2 },
      }).inputs.absent,
    ).toBe("missing");
  });

  it("carries parse problems into blockers without issuing a digest", () => {
    const review = reviewGraph(graph({ a: node({ dependsOn: ["missing"] }) }), {});
    expect(review.blockers.join("\n")).toContain("unknown dependsOn");
    expect(review.digest).toBeNull();
    expect(review.layers).toEqual([]);
  });

  it("keeps digests stable across graph and hash map key order", () => {
    const a = node({ inputs: [{ id: "input", kind: "workspace_snapshot", path: "input" }] });
    const b = {
      dependsOn: [],
      description: "Do the task",
      subject: "Task",
      schema: { required: ["answer"], type: "object" },
    };
    const left = reviewGraph(graph({ a, b }), { input: { sha256: HASH, sizeBytes: 1 } });
    const right = reviewGraph(
      {
        nodes: {
          b: {
            schema: { type: "object", required: ["answer"] },
            subject: "Task",
            description: "Do the task",
            dependsOn: [],
          },
          a,
        },
        schemaVersion: 1,
      },
      { input: { sizeBytes: 1, sha256: HASH } },
    );
    expect(left.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(right.digest).toBe(left.digest);
    expect(
      reviewGraph(graph({ a, b }), { input: { sha256: NEXT_HASH, sizeBytes: 1 } }).digest,
    ).not.toBe(left.digest);
    expect(reviewGraph(graph({ a, b }), { input: { sha256: HASH, sizeBytes: 2 } }).digest).not.toBe(
      left.digest,
    );
    expect(
      reviewGraph(graph({ a, b }), { input: { sha256: HASH, sizeBytes: 1 }, unrelated: "missing" })
        .digest,
    ).toBe(left.digest);
  });
});

describe("graph review write conflicts", () => {
  it("compares only nodes that can run together and write overlapping paths", () => {
    const value = graph({
      root: node({ scopes: { write: ["lib"] } }),
      mid: node({ dependsOn: ["root"], scopes: { write: ["lib/core"] } }),
      leaf: node({ dependsOn: ["mid"], scopes: { write: ["lib"] } }),
      side: node({ scopes: { write: ["lib/core/x.ts", "docs"] } }),
      docs: node({
        outputs: [{ id: "out", path: "docs/out.json" }],
        scopes: { read: ["lib"], write: [] },
      }),
      reader: node({ scopes: { read: ["lib"], write: [] } }),
      bare: node(),
    });
    // root, mid and leaf form one chain, so they never conflict with each other.
    expect(reviewGraph(value, {}).writeConflicts).toEqual([
      { nodes: ["docs", "side"], paths: ["docs", "docs/out.json"] },
      { nodes: ["root", "side"], paths: ["lib", "lib/core/x.ts"] },
      { nodes: ["side", "mid"], paths: ["lib/core", "lib/core/x.ts"] },
      { nodes: ["side", "leaf"], paths: ["lib", "lib/core/x.ts"] },
    ]);
  });
});

describe("graph capacity", () => {
  // A workflow starts at most this many agents (workflowRunner.test.ts pins the runner's side).
  const CAPACITY = 1000;
  // A judgment check adds a judge agent for each of the three attempts at its node.
  const JUDGES_PER_NODE = 3;
  const many = (count: number, make: (index: number) => unknown = () => node()) =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`n${index}`, make(index)]));
  const judged = () => node({ verify: { type: "judgment", rubric: ["Correct"] } });

  it("reviews a graph that exactly fills the workflow's agent capacity", () => {
    const reviewed = reviewGraph(graph(many(CAPACITY)), {});
    expect(reviewed.blockers).toEqual([]);
    expect(reviewed.digest).not.toBeNull();
    expect(reviewed.layers).toHaveLength(1);
    const perNode = 1 + JUDGES_PER_NODE;
    const full = reviewGraph(graph(many(CAPACITY / perNode, judged)), {});
    expect(full.blockers).toEqual([]);
    expect(full.digest).not.toBeNull();
  });

  it("blocks more nodes than the workflow can start, before looking inside any node", () => {
    const value = graph(many(CAPACITY + 1, () => ({})));
    const parsed = parseGraph(value);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems).toEqual([
      expect.stringContaining(String(CAPACITY + 1)),
    ]);
    const reviewed = reviewGraph(value, {});
    expect(reviewed.blockers).toHaveLength(1);
    expect(reviewed.blockers[0]).toContain(String(CAPACITY));
    expect(reviewed.digest).toBeNull();
    expect(reviewed.layers).toEqual([]);
    expect(reviewed.writeConflicts).toEqual([]);
  });

  it("counts the judge agents a judgment check can add at every attempt", () => {
    const perNode = 1 + JUDGES_PER_NODE;
    const fits = CAPACITY / perNode;
    const over = graph(many(fits + 1, judged));
    const reviewed = reviewGraph(over, {});
    expect(reviewed.blockers).toHaveLength(1);
    expect(reviewed.blockers[0]).toContain(String((fits + 1) * perNode));
    expect(reviewed.digest).toBeNull();
    expect(reviewed.layers).toEqual([]);
    // The same count of nodes without judges is well within capacity.
    expect(reviewGraph(graph(many(fits + 1)), {}).blockers).toEqual([]);
  });

  it("does not count process or structured checks as extra agents", () => {
    const checked = (index: number) =>
      node(
        index % 2 === 0
          ? { verify: { type: "process", argv: ["true"] } }
          : {
              schema: { type: "object" },
              verify: { type: "structured", requiredPointers: ["/ok"] },
            },
      );
    expect(reviewGraph(graph(many(CAPACITY, checked)), {}).blockers).toEqual([]);
  });

  it("never reports an over-capacity graph ready to start", () => {
    const value = graph(
      many(CAPACITY + 1, (index) => node({ dependsOn: index === 0 ? [] : ["n0"] })),
    );
    const reviewed = reviewGraph(value, {});
    expect(reviewed.blockers).not.toEqual([]);
    expect(reviewed.digest).toBeNull();
  });
});
it("uses omx attempt deadlines", () => {
  expect(attemptBudgetMs("short")).toBe(30 * 60_000);
  expect(attemptBudgetMs("standard")).toBe(2 * 60 * 60_000);
  expect(attemptBudgetMs()).toBe(2 * 60 * 60_000);
  expect(attemptBudgetMs("long")).toBe(6 * 60 * 60_000);
});

function driver(
  value: unknown,
  reports: Record<string, unknown> = {},
  inputs: Record<string, { sha256: string; sizeBytes: number } | "missing" | "too_large"> = {},
  /** False for a graph started before plans existed, whose host has no node(). */
  recordsNodes = true,
) {
  const calls: Array<{ prompt: string; options: Readonly<Record<string, unknown>> }> = [];
  const phases: string[] = [];
  const logs: string[] = [];
  const outcomes: Array<[string, unknown]> = [];
  const result = runWorkflowScript({
    source: GRAPH_DRIVER_SCRIPT,
    args: { graph: normalized(value), inputs },
    signal: new AbortController().signal,
    host: {
      agent: async (request) => {
        calls.push(request);
        return Object.hasOwn(reports, request.prompt)
          ? reports[request.prompt]
          : {
              ok: true,
              result: "done",
              attempts: 1,
              outputs: {},
              verification: null,
              reason: null,
            };
      },
      log: (message) => {
        logs.push(message);
      },
      phase: (title) => {
        phases.push(title);
      },
      meta: () => {},
      budget: () => ({ total: null, spent: 0 }),
      ...(recordsNodes
        ? { node: (key: string, outcome: unknown) => outcomes.push([key, outcome]) }
        : {}),
    } satisfies WorkflowScriptHost,
  });
  return { calls, phases, logs, outcomes, result };
}

/** A graph with a node that did not pass fails with a readable summary. */
async function failedRecord(result: Promise<unknown>): Promise<string> {
  const error = await result.then(
    () => {
      throw new Error("The graph should have failed.");
    },
    (failure: unknown) => failure,
  );
  const message = error instanceof Error ? error.message : String(error);
  expect(message.startsWith("Graph failed: ")).toBe(true);
  return message;
}

describe("graph driver in QuickJS", () => {
  it("runs a serial chain with deterministic phases and per-node options", async () => {
    const value = graph({
      a: node({
        description: "first",
        phase: "Plan",
        target: { model: "test" },
        role: "planner",
        schema: { type: "object" },
        scopes: { read: ["src"] },
        stallTimeoutMs: 60000,
        attemptBudget: "short",
      }),
      b: node({
        description: "second",
        dependsOn: ["a"],
        attemptBudget: "long",
        longBudgetApproved: true,
      }),
    });
    const run = driver(value);
    expect(await run.result).toMatchObject({
      ok: true,
      nodes: { a: { status: "passed", attempts: 1 }, b: { status: "passed" } },
    });
    expect(run.calls.map((call) => call.prompt)).toEqual(["first", "second"]);
    // Layer 1 holds only "a", which names its own phase.
    expect(run.phases).toEqual(["Layer 2"]);
    expect(run.calls[0]?.options).toMatchObject({
      report: true,
      phase: "Plan",
      target: { model: "test" },
      role: "planner",
      schema: { type: "object" },
      scopes: { read: ["src"], write: [] },
      stallTimeoutMs: 60000,
      attemptTimeoutMs: attemptBudgetMs("short"),
    });
    expect(run.calls[1]?.options).toMatchObject({
      report: true,
      phase: "Layer 2",
      attemptTimeoutMs: attemptBudgetMs("long"),
    });
    const resume = driver(value);
    expect(await resume.result).toEqual(await run.result);
    expect(resume.calls).toEqual(run.calls);
  });

  it("names a finished node by its label, not its key, in the progress text", async () => {
    const run = driver(
      graph({
        n1: node({ subject: "Scan the sources", description: "scan" }),
        n2: node({ subject: "Summarize the scan", description: "summarize", dependsOn: ["n1"] }),
      }),
      {
        summarize: {
          ok: false,
          result: null,
          attempts: 3,
          outputs: {},
          verification: null,
          reason: "x",
        },
      },
    );
    await run.result.catch(() => undefined);
    expect(run.logs).toEqual([
      "1/2 nodes finished; Scan the sources passed.",
      "2/2 nodes finished; Summarize the scan failed.",
    ]);
  });

  it("starts independent nodes concurrently and waits for both at fan-in", async () => {
    const started: string[] = [];
    let finishFirst: ((value: unknown) => void) | undefined;
    const report = {
      ok: true,
      result: null,
      attempts: 1,
      outputs: {},
      verification: null,
      reason: null,
    };
    const result = await runWorkflowScript({
      source: GRAPH_DRIVER_SCRIPT,
      args: {
        graph: normalized(
          graph({
            a: node({ description: "a" }),
            b: node({ description: "b" }),
            c: node({ description: "c", dependsOn: ["a", "b"] }),
          }),
        ),
        inputs: {},
      },
      signal: new AbortController().signal,
      host: {
        agent: (request) => {
          started.push(request.prompt);
          if (request.prompt === "a")
            return new Promise((resolve) => {
              finishFirst = resolve;
            });
          if (request.prompt === "b") {
            expect(started).toEqual(["a", "b"]);
            finishFirst?.(report);
          }
          return Promise.resolve(report);
        },
        log: () => {},
        phase: () => {},
        meta: () => {},
        budget: () => ({ total: null, spent: 0 }),
      },
    });
    expect(started).toEqual(["a", "b", "c"]);
    expect(result).toMatchObject({ ok: true, nodes: { c: { status: "passed" } } });
  });

  it("skips failed predecessors' dependents while independent nodes pass", async () => {
    const run = driver(
      graph({
        a: node({ description: "fails" }),
        b: node({ description: "skip", dependsOn: ["a"] }),
        c: node({ description: "skip too", dependsOn: ["b"] }),
        independent: node({ description: "works" }),
      }),
      {
        fails: {
          ok: false,
          result: null,
          attempts: 3,
          outputs: {},
          verification: { type: "process", outcome: "failed", attempts: 3, detail: "bad exit" },
          reason: "check failed",
        },
      },
    );
    expect(await failedRecord(run.result)).toContain(
      "Graph failed: 1 node failed, 2 skipped. Task: check failed",
    );
    expect(run.calls.map((call) => call.prompt)).toEqual(["fails", "works"]);
    expect(run.calls.map((call) => call.options.node)).toEqual(["a", "independent"]);
    expect(Object.fromEntries(run.outcomes)).toEqual({
      a: { status: "failed", attempts: 3, reason: "check failed" },
      b: { status: "skipped", attempts: 0, reason: "Predecessor a did not pass." },
      c: { status: "skipped", attempts: 0, reason: "Predecessor b did not pass." },
      independent: { status: "passed", attempts: 1 },
    });
    // Each node is recorded once.
    expect(run.outcomes).toHaveLength(4);
  });

  it("records nodes that fail or skip before any agent starts", async () => {
    const run = driver(
      graph({
        reader: node({
          description: "read",
          inputs: [{ id: "source", kind: "workspace_snapshot", path: "src/file" }],
        }),
        after: node({ description: "after", dependsOn: ["reader"] }),
      }),
      {},
      { "src/file": "missing" },
    );
    await failedRecord(run.result);
    expect(run.calls).toEqual([]);
    expect(Object.fromEntries(run.outcomes)).toEqual({
      reader: { status: "failed", attempts: 0, reason: "Input source has no reviewed hash." },
      after: { status: "skipped", attempts: 0, reason: "Predecessor reader did not pass." },
    });
  });

  it("still runs a graph resumed without node(), untagged", async () => {
    const run = driver(graph({ a: node({ description: "only" }) }), {}, {}, false);
    expect(await run.result).toMatchObject({ ok: true, nodes: { a: { status: "passed" } } });
    expect(run.calls[0]?.options.node).toBeUndefined();
  });

  it("pins workspace snapshots and returned task outputs with exact hashes", async () => {
    const outputs = {
      report: { path: "returned/report.json", sha256: NEXT_HASH, sizeBytes: 400000 },
    };
    const run = driver(
      graph({
        producer: node({
          description: "produce",
          inputs: [{ id: "source", kind: "workspace_snapshot", path: "src/file" }],
          outputs: [{ id: "report", path: "out/report.json", maxBytes: 500000 }],
          verify: { type: "structured", outputId: "report" },
        }),
        consumer: node({
          description: "consume",
          dependsOn: ["producer"],
          inputs: [{ id: "upstream", kind: "task_output", nodeId: "producer", outputId: "report" }],
        }),
      }),
      {
        produce: {
          ok: true,
          result: null,
          attempts: 2,
          outputs,
          verification: {
            type: "structured",
            outcome: "passed",
            attempts: 2,
            detail: "valid JSON",
          },
          reason: null,
        },
      },
      { "src/file": { sha256: HASH, sizeBytes: 10 } },
    );
    expect(await run.result).toMatchObject({
      ok: true,
      nodes: {
        producer: {
          attempts: 2,
          inputs: { source: HASH },
          outputs,
          verification: { outcome: "passed" },
        },
        consumer: { inputs: { upstream: NEXT_HASH } },
      },
    });
    expect(run.calls[0]?.options.inputs).toEqual([
      { id: "source", path: "src/file", maxBytes: 262144, sha256: HASH },
    ]);
    // What each node was given and produced is recorded with its outcome, digests included.
    expect(Object.fromEntries(run.outcomes)).toEqual({
      producer: { status: "passed", attempts: 2, inputs: { source: HASH }, outputs },
      consumer: { status: "passed", attempts: 1, inputs: { upstream: NEXT_HASH } },
    });
    expect(run.calls[0]?.options.verify).toMatchObject({ type: "structured", outputId: "report" });
    expect(run.calls[1]?.options.inputs).toEqual([
      {
        id: "upstream",
        path: "returned/report.json",
        maxBytes: 500000,
        sha256: NEXT_HASH,
        from: "producer",
      },
    ]);
  });

  it("records the digests of the inputs a node that did not pass was given, and no content", async () => {
    const run = driver(
      graph({
        reader: node({
          description: "read",
          inputs: [{ id: "source", kind: "workspace_snapshot", path: "src/file" }],
        }),
      }),
      {
        read: {
          ok: false,
          result: "a long answer that is not a record",
          attempts: 2,
          outputs: {},
          verification: { type: "process", outcome: "failed", attempts: 2, detail: "bad exit" },
          reason: "check failed",
        },
      },
      { "src/file": { sha256: HASH, sizeBytes: 10 } },
    );
    await failedRecord(run.result);
    expect(Object.fromEntries(run.outcomes)).toEqual({
      reader: {
        status: "failed",
        attempts: 2,
        reason: "check failed",
        inputs: { source: HASH },
      },
    });
  });

  it("refuses an unreviewed workspace snapshot", async () => {
    const run = driver(
      graph({
        a: node({ inputs: [{ id: "source", kind: "workspace_snapshot", path: "src/file" }] }),
      }),
    );
    expect(await failedRecord(run.result)).toContain("Task: Input source has no reviewed hash.");
    expect(Object.fromEntries(run.outcomes)).toEqual({
      a: { status: "failed", attempts: 0, reason: "Input source has no reviewed hash." },
    });
    expect(run.calls).toEqual([]);
  });

  it("fails closed for missing returned outputs and null agent reports", async () => {
    const missing = driver(
      graph({
        a: node({ description: "a", outputs: [{ id: "data", path: "data" }] }),
        b: node({
          dependsOn: ["a"],
          inputs: [{ id: "data", kind: "task_output", nodeId: "a", outputId: "data" }],
        }),
      }),
    );
    expect(await failedRecord(missing.result)).toContain(
      "Task: Predecessor a did not return output data.",
    );
    expect(Object.fromEntries(missing.outcomes)).toMatchObject({
      b: { status: "failed", reason: "Predecessor a did not return output data." },
    });
    const nullReport = driver(graph({ a: node({ description: "a" }) }), { a: null });
    expect(await failedRecord(nullReport.result)).toContain("Task: Agent did not pass.");
    expect(Object.fromEntries(nullReport.outcomes)).toEqual({
      a: { status: "failed", attempts: 0, reason: "Agent did not pass." },
    });
  });
});

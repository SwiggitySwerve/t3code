import { describe, expect, it } from "@effect/vitest";

import {
  checkWorkflowScript,
  runWorkflowScript,
  type WorkflowScriptHost,
} from "./workflowScript.ts";
import { WorkflowPhases } from "./workflowPhases.ts";

const host = (overrides: Partial<WorkflowScriptHost> = {}) => {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const logs: Array<string> = [];
  const phases: Array<string> = [];
  const metas: Array<unknown> = [];
  const progress = new WorkflowPhases();
  return {
    calls,
    logs,
    phases,
    metas,
    progress,
    host: {
      agent: async (request) => {
        calls.push({ prompt: request.prompt, options: { ...request.options } });
        await Promise.resolve();
        return `done:${request.prompt}`;
      },
      log: (message) => logs.push(message),
      phase: (title) => phases.push(title),
      progress: {
        start: (title, total) => progress.start(title, total),
        close: (index, state) => progress.close(index, state),
      },
      meta: (meta) => metas.push(meta),
      budget: () => ({ total: 100, spent: 40 }),
      ...overrides,
    } satisfies WorkflowScriptHost,
  };
};

const run = (source: string, input: ReturnType<typeof host>, args: unknown = null) =>
  runWorkflowScript({ source, args, host: input.host, signal: new AbortController().signal });

describe("workflow scripts", () => {
  it("preserves callback values and thrown identity, with independent nested and overlapping bars", async () => {
    const calls: Array<{ prompt: string; phaseIndex?: number }> = [];
    const h = host({
      agent: async (request) => {
        calls.push(request);
        return request.prompt;
      },
    });
    const result = await run(
      `
      const error = { original: true };
      let caught;
      try { await progress.phase("Failed", { total: 0 }, async () => { throw error; }); }
      catch (value) { caught = value === error; }
      const values = await Promise.all([
        progress.phase("Outer", { total: 2 }, async (bar) => {
          await bar.agent("outer first");
          await progress.phase("Inner", { total: 1 }, (inner) => inner.agent("inner"));
          return bar.agent("outer last");
        }),
        progress.phase("Sibling", { total: 1 }, async (bar) => {
          await Promise.resolve(); return bar.agent("sibling");
        }),
      ]);
      return { caught, values };`,
      h,
    );
    expect(result).toEqual({ caught: true, values: ["outer last", "sibling"] });
    const titles = new Map(h.progress.snapshot().map((phase) => [phase.index, phase.title]));
    expect(calls.map((call) => [call.prompt, titles.get(call.phaseIndex!)]).toSorted()).toEqual([
      ["inner", "Inner"],
      ["outer first", "Outer"],
      ["outer last", "Outer"],
      ["sibling", "Sibling"],
    ]);
    expect(h.progress.snapshot().map((phase) => phase.progress?.state)).toEqual([
      "failed",
      "completed",
      "completed",
      "completed",
    ]);
  });

  it.each(["-1", "1.5", "NaN", "Infinity", "1001", '"2"', "null", "undefined"])(
    "rejects an invalid phase total %s before invoking its callback",
    async (total) => {
      const h = host();
      await expect(
        run(`return progress.phase("Bad", { total: ${total} }, () => agent("never"))`, h),
      ).rejects.toThrow();
      expect(h.calls).toEqual([]);
      expect(h.progress.snapshot()).toEqual([]);
    },
  );

  it.each([
    [
      'let saved; await progress.phase("Empty", { total: 0 }, (bar) => { saved = bar; }); return saved.agent("late");',
      "closed",
    ],
    [
      'return progress.phase("Pending", { total: 1 }, (bar) => { bar.agent("pending"); });',
      "Await every bar.agent()",
    ],
    [
      'return progress.phase("Bound", { total: 1 }, (bar) => bar.agent("wrong", { phase: "Other" }));',
      "owns its phase",
    ],
    [
      'await progress.phase("Once", { total: 0 }, () => {}); return progress.phase("Once", { total: 0 }, () => {});',
      "only once",
    ],
  ])("rejects invalid phase lifetimes: %s", async (source, message) => {
    const h = host({ agent: () => new Promise(() => {}) });
    await expect(run(source, h)).rejects.toThrow(message);
  });

  it("closes a zero-agent phase without disposal syntax and preserves legacy phase()", async () => {
    const h = host();
    expect(
      await run('phase("Legacy"); return progress.phase("Empty", { total: 0 }, () => 42)', h),
    ).toBe(42);
    expect(h.phases).toEqual(["Legacy"]);
    expect(h.progress.snapshot()[0]?.progress).toEqual({ total: 0, state: "completed" });
    expect(await checkWorkflowScript("using bar = {};")).toContain("expecting");
    expect(await run("return typeof Symbol.dispose", h)).toBe("undefined");
  });

  it("retains phase identity when resumed callbacks enter in a different order", async () => {
    const phases = new WorkflowPhases([
      { index: 0, title: "First", progress: { total: 4, state: "completed" } },
      { index: 1, title: "Second", progress: { total: 3, state: "running" } },
    ]);
    const h = host({
      progress: {
        start: (title, total) => phases.start(title, total),
        close: (index, state) => phases.close(index, state),
      },
    });
    await run(
      'await progress.phase("Second", { total: 3 }, () => {}); await progress.phase("First", { total: 4 }, () => {});',
      h,
    );
    expect(phases.snapshot()).toEqual([
      { index: 0, title: "First", progress: { total: 4, state: "completed" } },
      { index: 1, title: "Second", progress: { total: 3, state: "completed" } },
    ]);
  });

  it("abandons a stopped callback without reporting success when its agent finishes late", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const agent = Promise.withResolvers<unknown>();
    const h = host({
      agent: () => {
        started.resolve();
        return agent.promise;
      },
    });
    const pending = runWorkflowScript({
      source: 'return progress.phase("Audit", { total: 1 }, (bar) => bar.agent("audit"))',
      args: null,
      host: h.host,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow("The workflow was stopped.");
    agent.resolve("late answer");
    await agent.promise;
    expect(h.progress.snapshot()[0]?.progress?.state).toBe("running");
  });

  it.each(['""', '" \\t "', '"x".repeat(501)', "123"])(
    "rejects invalid progress titles: %s",
    async (title) => {
      const h = host();
      await expect(
        run(`return progress.phase(${title}, { total: 0 }, () => 1)`, h),
      ).rejects.toThrow();
      expect(h.progress.snapshot()).toEqual([]);
    },
  );

  it("runs a Claude-format script with meta, args, parallel, pipeline and return", async () => {
    const h = host();
    const result = await run(
      `export const meta = { name: "demo", phases: [{ title: "Scan" }] }
const files = args.files
log("scanning", files.length)
const scanned = await parallel(files.map((file) => () => agent("scan " + file, { label: file, phase: "Scan" })))
phase("Review")
const reviewed = await pipeline(scanned, (text, original, index) => agent("review " + text + " #" + index))
return { scanned, reviewed }`,
      h,
      { files: ["a", "b"] },
    );
    expect(h.metas).toEqual([{ name: "demo", phases: [{ title: "Scan" }] }]);
    expect(h.logs).toEqual(["scanning 2"]);
    expect(h.phases).toEqual(["Review"]);
    expect(h.calls.slice(0, 2).map((call) => call.options)).toEqual([
      { label: "a", phase: "Scan" },
      { label: "b", phase: "Scan" },
    ]);
    expect(result).toEqual({
      scanned: ["done:scan a", "done:scan b"],
      reviewed: ["done:review done:scan a #0", "done:review done:scan b #1"],
    });
  });

  it("turns a failed step into null and keeps going", async () => {
    const h = host({
      agent: async (request) => {
        if (request.prompt === "bad") throw new Error("provider refused");
        return request.prompt;
      },
    });
    const result = await run(
      `return await parallel([() => agent("ok"), () => agent("bad"), () => { throw new Error("bug") }])`,
      h,
    );
    expect(result).toEqual(["ok", null, null]);
    expect(h.logs.toSorted()).toEqual([
      "A workflow step failed: bug",
      "A workflow step failed: provider refused",
    ]);
  });

  it("refuses the clock and randomness so a resumed run takes the same path", async () => {
    await expect(run("return Date.now()", host())).rejects.toThrow("Date.now() is unavailable");
    await expect(run("return Math.random()", host())).rejects.toThrow(
      "Math.random() is unavailable",
    );
    await expect(run("return new Date()", host())).rejects.toThrow("new Date() without a value");
    expect(await run('return new Date("2026-01-02T00:00:00Z").getUTCFullYear()', host())).toBe(
      2026,
    );
  });

  it("keeps Date arguments deterministic through calls and prototype constructors", async () => {
    expect(await run("return Date(0) === new Date(0).toString()", host())).toBe(true);
    // A replaced Array iterator must not turn the wrapper's arguments into none.
    expect(
      await run(
        "const epoch = new Date(0).toString(); Array.prototype[Symbol.iterator] = function* () {}; return [new Date(0).getTime(), Date(0) === epoch]",
        host(),
      ),
    ).toEqual([0, true]);
    expect(
      await run(
        "class Day extends Date {} const day = new Day(0); return [day instanceof Day, day.getTime()]",
        host(),
      ),
    ).toEqual([true, 0]);
    expect(
      await run(
        "return [new Date(0).getTime(), Date.UTC(1970, 0, 1), Date.parse('1970-01-01T00:00:00Z')]",
        host(),
      ),
    ).toEqual([0, 0, 0]);
    for (const constructor of [
      "Date",
      "new Date(0).constructor",
      "Object.getPrototypeOf(new Date(0)).constructor",
      "Date.prototype.constructor",
    ]) {
      await expect(run(`return (${constructor})()`, host())).rejects.toThrow("without a value");
      await expect(run(`return (${constructor}).now()`, host())).rejects.toThrow(
        "Date.now() is unavailable",
      );
      expect(await run(`return (${constructor}) === Date`, host())).toBe(true);
    }
  });

  it("has no host access", async () => {
    expect(
      await run(
        "return [typeof require, typeof process, typeof fetch, typeof globalThis.__host_agent]",
        host(),
      ),
    ).toEqual(["undefined", "undefined", "undefined", "undefined"]);
  });

  it("reports a script error and a compile error", async () => {
    await expect(run('throw new Error("args missing")', host())).rejects.toThrow("args missing");
    expect(await checkWorkflowScript("return 1")).toBeNull();
    expect(await checkWorkflowScript("return 1\nconst = 1")).toBe(
      "variable name expected (at workflow.js:2:7)",
    );
  });

  it("caps items per parallel call", async () => {
    await expect(
      run("return await parallel(Array.from({ length: 5000 }, () => () => 1))", host()),
    ).rejects.toThrow("at most 4096 items");
  });

  it("stops when aborted, abandoning pending agents", async () => {
    const controller = new AbortController();
    const pending = runWorkflowScript({
      source: 'return await agent("never finishes")',
      args: null,
      host: host({ agent: () => new Promise(() => {}) }).host,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("The workflow was stopped.");
  });
  it("exposes the workflow's token budget", async () => {
    const result = await run("return [budget.total, budget.spent, budget.remaining()]", host());
    expect(result).toEqual([100, 40, 60]);
  });
  it("returns null for a value with no JSON form", async () => {
    expect(await run("return () => 1", host())).toBeNull();
  });

  it("keeps error line numbers when blank lines precede the meta export", async () => {
    await expect(
      run('\n\nexport const meta = { name: "x" }\nthrow new Error("boom")', host()),
    ).rejects.toThrow(/workflow\.js:4/);
  });
});

import { describe, expect, it } from "@effect/vitest";

import {
  checkWorkflowScript,
  runWorkflowScript,
  type WorkflowScriptHost,
} from "./workflowScript.ts";

const host = (overrides: Partial<WorkflowScriptHost> = {}) => {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const logs: Array<string> = [];
  const phases: Array<string> = [];
  const metas: Array<unknown> = [];
  return {
    calls,
    logs,
    phases,
    metas,
    host: {
      agent: async (request) => {
        calls.push({ prompt: request.prompt, options: { ...request.options } });
        await Promise.resolve();
        return `done:${request.prompt}`;
      },
      log: (message) => logs.push(message),
      phase: (title) => phases.push(title),
      meta: (meta) => metas.push(meta),
      ...overrides,
    } satisfies WorkflowScriptHost,
  };
};

const run = (source: string, input: ReturnType<typeof host>, args: unknown = null) =>
  runWorkflowScript({ source, args, host: input.host, signal: new AbortController().signal });

describe("workflow scripts", () => {
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
});

/**
 * Runs a workflow script in QuickJS. The script sees only the workflow functions and its args:
 * no filesystem, network, process, clock or randomness. Each run gets its own WASM module.
 * Scripts follow Claude Code's Workflow format: an optional `export const meta`, then a body.
 */
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";

export interface WorkflowScriptHost {
  /** Resolves with the agent's result, or null when it failed or produced none. */
  readonly agent: (request: {
    readonly prompt: string;
    readonly options: Readonly<Record<string, unknown>>;
    readonly phaseIndex?: number;
  }) => Promise<unknown>;
  readonly log: (message: string) => void;
  readonly phase: (title: string) => void;
  readonly progress?: {
    readonly start: (title: unknown, total: unknown) => number;
    readonly close: (index: number, state: "completed" | "failed") => void;
  };
  readonly meta: (meta: unknown) => void;
  /** `total` is null when the workflow has no token budget. */
  readonly budget: () => { readonly total: number | null; readonly spent: number };
  /**
   * Records how a graph node ended; throws when the key or outcome is not valid. Only a
   * workflow started from a reviewed graph has it, so plain scripts see no `node` at all.
   */
  readonly node?: (key: string, outcome: unknown) => void;
}

/** Limits that keep a script from starving the server; agents run outside them. */
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const MAX_STACK_BYTES = 1024 * 1024;
const SYNC_SLICE_MS = 10_000;
const MAX_ITEMS_PER_CALL = 4096;

// Leading spaces only: \s* would also take the blank lines above and shift error line numbers.
const META_EXPORT = /^[ \t]*export\s+const\s+meta\s*=/m;

function wrap(source: string, graph = false): string {
  // The wrapper shares the script's first line, so error line numbers match the script.
  return `(async function (args, agent, parallel, pipeline, phase, log, budget, progress${graph ? ", node" : ""}) {${source.replace(
    META_EXPORT,
    "const meta = globalThis.__t3meta =",
  )}\n})`;
}

const PRELUDE = `
"use strict";
(() => {
  const host = { agent: __host_agent, log: __host_log, phase: __host_phase, meta: __host_meta, budget: __host_budget, node: globalThis.__host_node, startPhase: __host_startPhase, closePhase: __host_closePhase };
  for (const name of ["__host_agent", "__host_log", "__host_phase", "__host_meta", "__host_budget", "__host_node", "__host_startPhase", "__host_closePhase"]) delete globalThis[name];
  const unavailable = (name) => () => {
    throw new Error(name + " is unavailable in workflows: runs must be deterministic to resume.");
  };
  Math.random = unavailable("Math.random()");
  const RealDate = Date;
  // Reflect.construct reads the argument list by index; a spread would run the script's own
  // Array iterator, which can hand the real constructor no arguments and so the current time.
  const construct = Reflect.construct;
  const WorkflowDate = function Date(...values) {
    if (values.length === 0) throw new Error("new Date() without a value is unavailable in workflows.");
    const date = construct(RealDate, values, new.target ?? RealDate);
    return new.target ? date : date.toString();
  };
  WorkflowDate.prototype = RealDate.prototype;
  Object.defineProperty(WorkflowDate.prototype, "constructor", { value: WorkflowDate, writable: true, configurable: true });
  WorkflowDate.UTC = RealDate.UTC;
  WorkflowDate.parse = RealDate.parse;
  WorkflowDate.now = unavailable("Date.now()");
  globalThis.Date = WorkflowDate;
  Object.defineProperty(globalThis, "__t3meta", {
    set(value) { host.meta(JSON.stringify(value) ?? "null"); },
  });
  const message = (error) => (error && error.message) || String(error);
  const runAgent = (prompt, options, phaseIndex) => {
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return Promise.reject(new Error("agent() needs a non-empty prompt string."));
    }
    return host
      .agent(JSON.stringify({ prompt, options: options === undefined ? {} : options, phaseIndex }))
      .then((text) => JSON.parse(text));
  };
  const agent = (prompt, options) => runAgent(prompt, options);
  const progress = Object.freeze({
    phase: async (title, options, callback) => {
      if (typeof callback !== "function") throw new Error("progress.phase() needs a callback.");
      const index = host.startPhase(JSON.stringify([title, options && options.total]));
      let closed = false;
      let pending = 0;
      const bar = Object.freeze({
        agent: async (prompt, options) => {
          if (closed) throw new Error("This progress phase is closed.");
          if (options && options.phase !== undefined) throw new Error("bar.agent() owns its phase; omit options.phase.");
          pending++;
          try { return await runAgent(prompt, options, index); }
          finally { pending--; }
        },
      });
      let value;
      try { value = await callback(bar); }
      catch (error) {
        closed = true;
        try { host.closePhase(index, "failed"); }
        finally { throw error; }
      }
      closed = true;
      host.closePhase(index, pending > 0 ? "failed" : "completed");
      if (pending > 0) throw new Error("Await every bar.agent() before its progress phase closes.");
      return value;
    },
  });
  const settle = (start) => {
    let promise;
    try { promise = Promise.resolve(start()); } catch (error) { promise = Promise.reject(error); }
    return promise.then(
      (value) => (value === undefined ? null : value),
      (error) => { host.log("A workflow step failed: " + message(error)); return null; },
    );
  };
  const tooMany = (name, count) => {
    if (count > ${MAX_ITEMS_PER_CALL}) throw new Error(name + "() takes at most ${MAX_ITEMS_PER_CALL} items; got " + count + ".");
  };
  const parallel = (thunks) => {
    if (!Array.isArray(thunks)) throw new Error("parallel() takes an array of functions.");
    tooMany("parallel", thunks.length);
    return Promise.all(thunks.map((thunk) => settle(thunk)));
  };
  const pipeline = (items, ...stages) => {
    if (!Array.isArray(items)) throw new Error("pipeline() takes an array of items.");
    if (stages.length === 0) throw new Error("pipeline() needs at least one stage function.");
    tooMany("pipeline", items.length);
    return Promise.all(
      items.map((item, index) =>
        stages.reduce(
          (previous, stage, stageIndex) =>
            previous.then((value) =>
              stageIndex > 0 && value === null ? null : settle(() => stage(value, item, index)),
            ),
          Promise.resolve(item),
        ),
      ),
    );
  };
  const phase = (title) => { host.phase(String(title)); };
  const log = (...parts) => { host.log(parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" ")); };
  const tokens = () => JSON.parse(host.budget());
  const budget = Object.freeze({
    get total() { return tokens().total; },
    get spent() { return tokens().spent; },
    remaining: () => {
      const { total, spent } = tokens();
      return total === null ? Infinity : Math.max(0, total - spent);
    },
  });
  const node = host.node === undefined
    ? undefined
    : (key, outcome) => { host.node(String(key), JSON.stringify(outcome ?? null)); };
  globalThis.__t3 = Object.freeze({ agent, parallel, pipeline, phase, log, budget, progress, node });
})();
`;

function errorText(context: QuickJSContext, handle: QuickJSHandle): string {
  const dumped: unknown = context.dump(handle);
  if (typeof dumped === "object" && dumped !== null) {
    const record = dumped as { message?: unknown; stack?: unknown; name?: unknown };
    const head = typeof record.message === "string" ? record.message : JSON.stringify(dumped);
    const where = typeof record.stack === "string" ? record.stack.split("\n")[0]?.trim() : "";
    return where ? `${head} (${where})` : head;
  }
  return String(dumped);
}

/** Returns why the script cannot compile, or null when it does. */
export async function checkWorkflowScript(source: string): Promise<string | null> {
  const module = await newQuickJSWASMModule();
  const runtime = module.newRuntime();
  const context = runtime.newContext();
  try {
    const result = context.evalCode(wrap(source), "workflow.js", { compileOnly: true });
    if (result.error === undefined) {
      result.value.dispose();
      return null;
    }
    const text = errorText(context, result.error);
    result.error.dispose();
    return text;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

/**
 * Runs the script to completion. Resolves with its JSON return value; rejects with
 * the script's error. Aborting the signal stops it and abandons pending agent calls.
 */
export async function runWorkflowScript(input: {
  readonly source: string;
  readonly args: unknown;
  readonly host: WorkflowScriptHost;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  if (input.signal.aborted) throw new Error("The workflow was stopped.");
  const module = await newQuickJSWASMModule();
  if (input.signal.aborted) throw new Error("The workflow was stopped.");
  const runtime: QuickJSRuntime = module.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  const context = runtime.newContext();
  const deferreds = new Set<QuickJSDeferredPromise>();
  let closed = false;
  let fail: (error: Error) => void = () => {};

  // Bounds each synchronous stretch of script code; awaited agents do not count.
  const setSliceDeadline = () => {
    const deadline = performance.now() + SYNC_SLICE_MS;
    runtime.setInterruptHandler(() => performance.now() > deadline);
  };
  const pump = () => {
    if (closed) return;
    setSliceDeadline();
    const jobs = runtime.executePendingJobs();
    if (jobs.error !== undefined) {
      const text = errorText(context, jobs.error);
      jobs.error.dispose();
      fail(new Error(text));
    }
  };

  const define = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | void) => {
    const handle = context.newFunction(name, fn);
    context.setProp(context.global, name, handle);
    handle.dispose();
  };
  define("__host_log", (message) => {
    input.host.log(context.getString(message));
  });
  define("__host_phase", (title) => {
    input.host.phase(context.getString(title));
  });
  define("__host_startPhase", (request) => {
    const [title, total] = JSON.parse(context.getString(request));
    if (input.host.progress === undefined)
      throw new Error("Progress phases are unavailable on this host.");
    return context.newNumber(input.host.progress.start(title, total));
  });
  define("__host_closePhase", (index, state) => {
    input.host.progress?.close(
      context.getNumber(index),
      context.getString(state) as "completed" | "failed",
    );
  });
  define("__host_budget", () => context.newString(JSON.stringify(input.host.budget())));
  define("__host_meta", (meta) => {
    input.host.meta(JSON.parse(context.getString(meta)));
  });
  const recordNode = input.host.node;
  if (recordNode !== undefined) {
    define("__host_node", (key, outcome) => {
      recordNode(context.getString(key), JSON.parse(context.getString(outcome)));
    });
  }
  define("__host_agent", (requestHandle) => {
    const request = JSON.parse(context.getString(requestHandle)) as {
      prompt: string;
      options: Record<string, unknown>;
      phaseIndex?: number;
    };
    const deferred = context.newPromise();
    deferreds.add(deferred);
    const settle = (apply: () => void) => {
      if (closed) return;
      deferreds.delete(deferred);
      apply();
      deferred.dispose();
      pump();
    };
    input.host.agent(request).then(
      (value) =>
        settle(() => {
          // Functions and symbols have no JSON form; they reach the script as null.
          const handle = context.newString(JSON.stringify(value) ?? "null");
          deferred.resolve(handle);
          handle.dispose();
        }),
      (error: unknown) =>
        settle(() => {
          const handle = context.newError(error instanceof Error ? error.message : String(error));
          deferred.reject(handle);
          handle.dispose();
        }),
    );
    return deferred.handle;
  });

  try {
    const prelude = context.evalCode(PRELUDE, "prelude.js");
    context.unwrapResult(prelude).dispose();
    const argsHandle = context.newString(
      JSON.stringify(input.args === undefined ? null : input.args),
    );
    context.setProp(context.global, "__t3_args", argsHandle);
    argsHandle.dispose();
    setSliceDeadline();
    const started = context.evalCode(
      `${wrap(input.source, recordNode !== undefined)}.call(undefined, JSON.parse(__t3_args), __t3.agent, __t3.parallel, __t3.pipeline, __t3.phase, __t3.log, __t3.budget, __t3.progress, __t3.node).then((value) => JSON.stringify(value) ?? "null")`,
      "workflow.js",
    );
    if (started.error !== undefined) {
      const text = errorText(context, started.error);
      started.error.dispose();
      throw new Error(text);
    }
    const settled = context.resolvePromise(started.value);
    started.value.dispose();
    const outcome = await new Promise<QuickJSHandle>((resolve, reject) => {
      fail = reject;
      const abort = () => reject(new Error("The workflow was stopped."));
      if (input.signal.aborted) abort();
      input.signal.addEventListener("abort", abort, { once: true });
      settled.then((result) => {
        if (result.error !== undefined) {
          const text = errorText(context, result.error);
          result.error.dispose();
          reject(new Error(text));
        } else {
          resolve(result.value);
        }
      }, reject);
      pump();
    });
    const text = context.getString(outcome);
    outcome.dispose();
    return JSON.parse(text);
  } finally {
    closed = true;
    for (const deferred of deferreds) deferred.dispose();
    try {
      context.dispose();
      runtime.dispose();
    } catch {
      // A script stopped mid-flight can leave QuickJS objects alive; its module is
      // private to this run, so dropping it is safe.
    }
  }
}

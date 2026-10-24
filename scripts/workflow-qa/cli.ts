// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - hand-run CLI tooling, outside any Effect runtime.
// Workflow QA tooling: fixture screenshots, live screenshots, an isolated server lane, and a gate
// that runs in a snapshot worktree. Each command lives in its own module; this file only parses
// arguments and calls them.
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { runCapture } from "./capture.ts";
import { runGate } from "./gate.ts";
import { compareManifests, readManifest } from "./manifest.ts";
import { laneStatus, pairLane, removeLane, startLane, stopLane } from "./lane.ts";
import { runShot } from "./shot.ts";
import { createSnapshot, removeSnapshot } from "./snapshot.ts";

const USAGE = `Usage: node scripts/workflow-qa/cli.ts <command> [options]

  capture   --out <dir> [--repo <checkout>] [-- <vp test args>]
            Run the fixture browser tests with screenshots on; verify and collect every frame.
  shot      --url <url> --selector <css> --surface <name> --state <name> --out <dir>
            [--storage-state <file>] [--repo <checkout>] [--timeout <ms>] [--channel <browser>]
            Screenshot one element of a live page in every theme and width. Fails if the
            selector matches nothing.
  lane      start|stop|status|pair|remove --name <lane> [--repo <checkout>] [--dir <folder>] --source <dev home>
            An isolated server and web dev server with their own home, ports and pairing.
  snapshot  create|remove --label <name> [--repo <checkout>] [--no-install]
            A sibling worktree holding the checkout's current files.
  compare   --baseline <dir> --current <dir>
            Compare two capture folders by frame name and image hash: same, changed, added, removed.
  gate      --label <name> [--base main] [--out <dir>] [--baseline-log <file>] [--keep|--reuse [--allow-stale]] [-- <vp args>]
            Run check:changed on a snapshot worktree and compare failures with a baseline.
            --reuse runs in the snapshot that "snapshot create" made and leaves it in place; it
            refuses a snapshot whose files differ from the checkout's unless --allow-stale.

--repo defaults to the checkout this script is in.
`;

const defaultRepo = NodePath.resolve(import.meta.dirname, "..", "..");

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...rest],
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: "string" },
      out: { type: "string" },
      url: { type: "string" },
      selector: { type: "string" },
      surface: { type: "string" },
      state: { type: "string" },
      "storage-state": { type: "string" },
      timeout: { type: "string" },
      channel: { type: "string" },
      name: { type: "string" },
      dir: { type: "string" },
      source: { type: "string" },
      label: { type: "string" },
      base: { type: "string" },
      "baseline-log": { type: "string" },
      keep: { type: "boolean" },
      reuse: { type: "boolean" },
      "allow-stale": { type: "boolean" },
      "no-install": { type: "boolean" },
      baseline: { type: "string" },
      current: { type: "string" },
    },
  });
  const repo = values.repo ?? defaultRepo;
  const need = (name: string, value: string | undefined): string => {
    if (value === undefined) throw new Error(`--${name} is required.`);
    return value;
  };
  switch (command) {
    case "capture":
      return runCapture({
        repo,
        toolRepo: defaultRepo,
        out: need("out", values.out),
        testArgs: positionals,
      });
    case "shot":
      return await runShot({
        repo,
        toolRepo: defaultRepo,
        url: need("url", values.url),
        selector: need("selector", values.selector),
        surface: need("surface", values.surface),
        state: need("state", values.state),
        out: need("out", values.out),
        storageState: values["storage-state"],
        timeoutMs: Number(values.timeout ?? 30_000),
        channel: values.channel,
      });
    case "lane": {
      const [action] = positionals;
      const lane = {
        repo,
        name: need("name", values.name),
        dir: values.dir,
        source: action === "start" ? need("source", values.source) : (values.source ?? ""),
      };
      switch (action) {
        case "start":
          return await startLane(lane);
        case "stop":
          return await stopLane(lane);
        case "status":
          return laneStatus(lane);
        case "pair":
          return await pairLane(lane);
        case "remove":
          return await removeLane(lane);
        default:
          throw new Error("lane needs start, stop, status, pair or remove.");
      }
    }
    case "snapshot": {
      const [action] = positionals;
      const label = need("label", values.label);
      if (action === "create") {
        const snapshot = createSnapshot({ repo, label, install: values["no-install"] !== true });
        console.log(`${snapshot.path} ${snapshot.commit}`);
        return 0;
      }
      if (action === "remove") {
        removeSnapshot({ repo, label });
        return 0;
      }
      throw new Error("snapshot needs create or remove.");
    }
    case "compare": {
      const result = compareManifests(
        readManifest(need("baseline", values.baseline)),
        readManifest(need("current", values.current)),
      );
      console.log(
        `compare: ${result.same} same, ${result.changed.length} changed, ${result.added.length} added, ${result.removed.length} removed.`,
      );
      for (const [label, names] of [
        ["changed", result.changed],
        ["added", result.added],
        ["removed", result.removed],
      ] as const) {
        for (const name of names) console.log(`  ${label}: ${name}`);
      }
      return 0;
    }
    case "gate": {
      const label = need("label", values.label);
      return runGate({
        repo,
        label,
        base: values.base ?? "main",
        out: values.out ?? NodePath.join(repo, ".logs", "workflow-qa", `gate-${label}`),
        baselineLog: values["baseline-log"],
        keep: values.keep === true,
        reuse: values.reuse === true,
        allowStale: values["allow-stale"] === true,
        command: positionals,
      });
    }
    default:
      console.log(USAGE);
      return command === undefined || command === "help" ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);

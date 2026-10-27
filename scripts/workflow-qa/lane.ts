// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - hand-run CLI tooling, outside any Effect runtime.
// An isolated QA lane: its own T3 server and web dev server on their own ports, its own base
// directory seeded from a read-only copy of the dev home, and its own pairing.
//
//   node scripts/workflow-qa/cli.ts lane start|stop|status|pair|remove --name <lane>
//     [--repo <checkout>] [--dir <lane folder>] [--source <dev home>]
//
// The lane never writes to the dev home or an installed app, and neither do the providers it
// starts: both proxy providers get a lane-local home (see `seedLaneHome`), so sessions, history
// and config edits stay inside the lane folder. Run the lane from a snapshot worktree (see
// `snapshot`) so QA exercises a fixed tree.
//
// Ownership: `lane.json` is the lane's manifest. A folder without one is never adopted or
// deleted. Every process the lane spawns is recorded (pid and start time) the moment it exists, so
// `stop` and `remove` can reach it however far a start got; a process is only killed after its pid,
// start time and exact command-line option match what was recorded.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { workflowQaDefaultEnabledStockInstances } from "@t3tools/shared/testing/workflowQa";
import * as Effect from "effect/Effect";

import { launchBrowser } from "./playwright.ts";
import { assertLabel, isEmptyOrMissing } from "./util.ts";

const isWindows = (): boolean =>
  Effect.runSync(
    Effect.gen(function* () {
      return (yield* HostProcess.Platform) === "win32";
    }),
  );

/** The only provider instances a lane gets; the rest of the dev home's providers stay behind. */
export const QA_PROVIDER_INSTANCES = ["cliproxy", "claudeproxy"] as const;

/** Workflow profiles that exist only in a lane's home: a cheap worker and a stronger verifier. */
export const QA_PROFILES = [
  {
    id: "qa-worker",
    name: "QA worker (Haiku)",
    target: {
      providerInstanceId: "cliproxy",
      model: "claude-haiku-5-5",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: "default" },
      ],
    },
  },
  {
    id: "qa-verifier",
    name: "QA verifier (Opus)",
    target: {
      providerInstanceId: "cliproxy",
      model: "claude-opus-5-5",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "default" },
      ],
    },
  },
] as const;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The lane-local homes of the two proxy providers, inside the lane's base directory. */
export interface LaneProviderHomes {
  readonly claude: string;
  readonly codex: string;
}

/**
 * What a lane's settings.json holds, built from an allowlist: the lane's providers, the QA
 * profiles, and the dev home's default model when a lane provider serves it. Nothing else in the
 * dev settings is copied, so a setting added later never reaches a lane by accident. The input is
 * never modified.
 */
export function buildLaneSettings(source: unknown, homes: LaneProviderHomes): Json {
  if (!isRecord(source)) throw new Error("The dev home's settings.json is not an object.");
  const instances = isRecord(source.providerInstances) ? source.providerInstances : {};
  // Instances the dev home switched off stay off. Every stock instance the app would otherwise
  // enable by default (codex, claudeAgent) is written disabled whatever the dev home says, so
  // none starts in the user's default provider home. Other instances, such as a hosted provider,
  // are left behind.
  const kept = Object.fromEntries(
    Object.entries(instances).flatMap(([id, instance]) =>
      isRecord(instance) &&
      ((QA_PROVIDER_INSTANCES as ReadonlyArray<string>).includes(id) || instance.enabled === false)
        ? [[id, structuredClone(instance)]]
        : [],
    ),
  );
  for (const { id, driver } of workflowQaDefaultEnabledStockInstances()) {
    if (!(QA_PROVIDER_INSTANCES as ReadonlyArray<string>).includes(id)) {
      kept[id] = { driver, enabled: false };
    }
  }
  const withHome = (id: string, config: Json) => {
    const instance = kept[id];
    if (isRecord(instance)) {
      instance.config = { ...(isRecord(instance.config) ? instance.config : {}), ...config };
    }
  };
  withHome("claudeproxy", { homePath: homes.claude });
  // Existing mode with an empty shadow path: the provider runs directly in the lane-local home.
  withHome("cliproxy", { homePath: homes.codex, shadowHomePath: "", setupMode: "existing" });
  const selection = source.defaultModelSelection;
  const selectionServed =
    isRecord(selection) &&
    typeof selection.instanceId === "string" &&
    (QA_PROVIDER_INSTANCES as ReadonlyArray<string>).includes(selection.instanceId);
  return {
    providerInstances: kept,
    workflowPresets: { presets: structuredClone(QA_PROFILES), defaultPresetId: "qa-worker" },
    ...(selectionServed ? { defaultModelSelection: structuredClone(selection) } : {}),
  };
}

/** The saved environment variables of the lane's provider instances; no other secret is copied. */
export function laneSecretFiles(names: ReadonlyArray<string>): Array<string> {
  const prefixes = QA_PROVIDER_INSTANCES.map(
    (id) => `provider-env-${Buffer.from(id).toString("base64url")}-`,
  );
  return names.filter(
    (name) => name.endsWith(".bin") && prefixes.some((prefix) => name.startsWith(prefix)),
  );
}

// Top-level Codex settings a lane needs to talk to the proxy; everything else in config.toml
// (agent registrations, MCP servers, project trust, plugins) stays in the dev home.
const CODEX_TOP_LEVEL_KEYS = new Set([
  "model",
  "model_provider",
  "model_reasoning_effort",
  "service_tier",
]);
const MODEL_PROVIDER_TABLE = /^\[model_providers\.[^\]]+\]\s*$/;

/** The lane's slice of a Codex config.toml: its model keys and the `model_providers` tables. */
export function laneCodexConfig(toml: string): string {
  const kept: Array<string> = [];
  let inTopLevel = true;
  let keepTable = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[/.test(line);
    if (header) {
      inTopLevel = false;
      keepTable = MODEL_PROVIDER_TABLE.test(line.trim());
      if (keepTable) kept.push("", line.trim());
    } else if (inTopLevel) {
      const key = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line)?.[1];
      if (key !== undefined && CODEX_TOP_LEVEL_KEYS.has(key)) kept.push(line);
    } else if (keepTable && line.trim() !== "") {
      kept.push(line);
    }
  }
  // Top-level keys must come before any table, which they already do in the source order.
  return `${kept.join("\n").trimStart()}\n`;
}

/**
 * Whether a Codex auth.json holds only a static API key. A file with OAuth tokens is rotating
 * state that two Codex homes would fight over, so it is never copied.
 */
export function isStaticCodexAuth(text: string): boolean {
  try {
    const auth: unknown = JSON.parse(text);
    return (
      isRecord(auth) &&
      Object.keys(auth).every((key) => key === "auth_mode" || key === "OPENAI_API_KEY") &&
      typeof auth.OPENAI_API_KEY === "string" &&
      auth.OPENAI_API_KEY !== "" &&
      String(auth.auth_mode ?? "apikey").toLowerCase() === "apikey"
    );
  } catch {
    return false;
  }
}

export interface LanePaths {
  readonly dir: string;
  readonly home: string;
  readonly state: string;
  readonly serverLog: string;
  readonly webLog: string;
  readonly storageState: string;
}

export function lanePaths(repo: string, name: string, dir: string | undefined): LanePaths {
  assertLabel("lane name", name);
  const root = NodePath.resolve(repo);
  const lane = NodePath.resolve(
    dir ?? NodePath.join(NodePath.dirname(root), "t3code-qa-lanes", name),
  );
  return {
    dir: lane,
    home: NodePath.join(lane, "home"),
    state: NodePath.join(lane, "lane.json"),
    serverLog: NodePath.join(lane, "server.log"),
    webLog: NodePath.join(lane, "web.log"),
    storageState: NodePath.join(lane, "pw-state.json"),
  };
}

/** Everything a lane writes into its folder, and so everything `remove` may delete. */
const ownedPaths = (paths: LanePaths): ReadonlyArray<string> => [
  paths.home,
  paths.serverLog,
  paths.webLog,
  paths.storageState,
  // The manifest goes last: until it is gone, a half-finished removal can be repeated.
  paths.state,
];

/** What `seedLaneHome` left in the lane, by name only; secrets are never printed. */
export interface SeedReport {
  readonly codexFiles: ReadonlyArray<string>;
  readonly codexAuthSkipped: boolean;
  readonly claudeFiles: ReadonlyArray<string>;
}

/** Copies the lane's slice of the dev home into `home`, reading the source and nothing else. */
export function seedLaneHome(source: string, home: string): SeedReport {
  const sourceUserdata = NodePath.join(source, "userdata");
  const settings: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(sourceUserdata, "settings.json"), "utf8"),
  );
  const homeOf = (id: string): string | undefined => {
    const instance =
      isRecord(settings) && isRecord(settings.providerInstances)
        ? settings.providerInstances[id]
        : undefined;
    const config = isRecord(instance) ? instance.config : undefined;
    return isRecord(config) && typeof config.homePath === "string" && config.homePath.trim() !== ""
      ? config.homePath
      : undefined;
  };
  const claudeSource = homeOf("claudeproxy");
  // An instance with no home of its own runs in the user's default Codex home.
  const codexSource = homeOf("cliproxy") ?? NodePath.join(NodeOS.homedir(), ".codex");
  const homes: LaneProviderHomes = {
    claude: NodePath.join(home, "claude-proxy-home"),
    codex: NodePath.join(home, "codex-proxy-home"),
  };
  const userdata = NodePath.join(home, "userdata");
  NodeFS.mkdirSync(NodePath.join(userdata, "secrets"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    `${JSON.stringify(buildLaneSettings(settings, homes), null, 2)}\n`,
  );
  const secrets = NodePath.join(sourceUserdata, "secrets");
  if (NodeFS.existsSync(secrets)) {
    for (const name of laneSecretFiles(NodeFS.readdirSync(secrets))) {
      NodeFS.copyFileSync(NodePath.join(secrets, name), NodePath.join(userdata, "secrets", name));
    }
  }
  const claudeFiles: Array<string> = [];
  if (claudeSource !== undefined) {
    NodeFS.mkdirSync(homes.claude, { recursive: true });
    // Configuration only: the proxy home's projects and sessions are the dev home's history.
    for (const name of [".claude.json", "settings.json"]) {
      const from = NodePath.join(claudeSource, name);
      if (NodeFS.existsSync(from)) {
        NodeFS.copyFileSync(from, NodePath.join(homes.claude, name));
        claudeFiles.push(name);
      }
    }
  }
  // The Codex home gets the proxy configuration and its static key, never sessions, history,
  // logs, the model cache or rotating login state.
  const codexFiles: Array<string> = [];
  let codexAuthSkipped = false;
  NodeFS.mkdirSync(homes.codex, { recursive: true });
  const config = NodePath.join(codexSource, "config.toml");
  if (NodeFS.existsSync(config)) {
    NodeFS.writeFileSync(
      NodePath.join(homes.codex, "config.toml"),
      laneCodexConfig(NodeFS.readFileSync(config, "utf8")),
    );
    codexFiles.push("config.toml");
  }
  const auth = NodePath.join(codexSource, "auth.json");
  if (NodeFS.existsSync(auth)) {
    const text = NodeFS.readFileSync(auth, "utf8");
    if (isStaticCodexAuth(text)) {
      NodeFS.writeFileSync(NodePath.join(homes.codex, "auth.json"), text);
      codexFiles.push("auth.json");
    } else {
      codexAuthSkipped = true;
    }
  }
  return { codexFiles, codexAuthSkipped, claudeFiles };
}

const STATE_KIND = "workflow-qa-lane";

/** A process the lane started: the pid alone is not an identity once the process has exited. */
export interface ProcessRecord {
  readonly pid: number;
  readonly startedAt: string;
}

export interface LaneState {
  readonly kind: typeof STATE_KIND;
  readonly name: string;
  readonly repo: string;
  readonly home: string;
  readonly serverPort: number;
  readonly webPort: number;
  /** Null until that process has been spawned. */
  readonly server: ProcessRecord | null;
  readonly web: ProcessRecord | null;
  readonly startedAt: string;
}

/** The lane's manifest, or null when the folder has none. Throws for a `lane.json` that is not ours. */
function readState(paths: LanePaths): LaneState | null {
  if (!NodeFS.existsSync(paths.state)) return null;
  const state: unknown = JSON.parse(NodeFS.readFileSync(paths.state, "utf8"));
  if (!isRecord(state) || state.kind !== STATE_KIND || typeof state.home !== "string") {
    throw new Error(`${paths.state} is not a lane manifest written by this tool.`);
  }
  return state as unknown as LaneState;
}

const writeState = (paths: LanePaths, state: LaneState): void =>
  NodeFS.writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);

/** Whether a command line carries `option value` as exact arguments, not as part of a longer one. */
export function commandHasOption(command: string, option: string, value: string): boolean {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escape(option)}(?:\\s+|=)"?${escape(value)}"?(?=\\s|$)`).test(
    command,
  );
}

export interface ProcessSnapshot {
  readonly startedAt: string;
  readonly command: string;
}

/** Everything the lane does to the machine, so the failure paths can be tested without it. */
export interface LaneHost {
  /** Starts a detached process; rejects when it cannot be started. */
  readonly spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: { cwd: string; env: NodeJS.ProcessEnv; log: string },
  ) => Promise<ProcessRecord>;
  /** The process with this pid, or null when none is running. */
  readonly inspect: (pid: number) => ProcessSnapshot | null;
  /** Kills the process and its children. */
  readonly kill: (pid: number) => void;
  readonly portListening: (port: number, host: string) => Promise<boolean>;
  readonly waitForHttp: (url: string, timeoutMs: number) => Promise<boolean>;
  readonly freePort: () => Promise<number>;
  /** How long a stop waits for a killed process to disappear and its ports to free. */
  readonly settleMs: number;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function portListening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = NodeNet.createConnection({ port, host });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Start time and command line of a running process, or null when it is gone. */
function inspectProcess(pid: number): ProcessSnapshot | null {
  try {
    if (isWindows()) {
      const output = NodeChildProcess.execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') + [char]9 + $p.CommandLine }`,
        ],
        { encoding: "utf8" },
      ).trim();
      const tab = output.indexOf("\t");
      return tab < 0
        ? null
        : { startedAt: output.slice(0, tab), command: output.slice(tab + 1).trim() };
    }
    const ps = (field: string) =>
      NodeChildProcess.execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
    const startedAt = ps("lstart");
    return startedAt === "" ? null : { startedAt, command: ps("command") };
  } catch {
    return null;
  }
}

function killTree(pid: number): void {
  if (isWindows()) {
    NodeChildProcess.execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    process.kill(-pid, "SIGTERM");
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (reachable) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

/**
 * Starts a detached process and records its identity. A command that cannot be started rejects
 * (spawn reports that through an `error` event, not an exception), and a process that is already
 * gone when it is first inspected is reported rather than recorded.
 */
export function spawnTracked(
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd: string; env: NodeJS.ProcessEnv; log: string },
  inspect: LaneHost["inspect"] = inspectProcess,
): Promise<ProcessRecord> {
  return new Promise((resolve, reject) => {
    const log = NodeFS.openSync(options.log, "a");
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    // After a successful start an error can still arrive (a failed kill); it must not crash the CLI.
    child.once("error", (error) => {
      NodeFS.closeSync(log);
      reject(new Error(`Could not start ${command}: ${error.message}`));
    });
    child.once("spawn", () => {
      NodeFS.closeSync(log);
      child.unref();
      const pid = child.pid;
      const snapshot = pid === undefined ? null : inspect(pid);
      if (pid === undefined || snapshot === null) {
        reject(new Error(`${command} exited as soon as it started; see ${options.log}.`));
      } else {
        resolve({ pid, startedAt: snapshot.startedAt });
      }
    });
  });
}

const realHost: LaneHost = {
  spawn: (command, args, options) => spawnTracked(command, args, options),
  inspect: inspectProcess,
  kill: killTree,
  portListening,
  waitForHttp,
  freePort,
  settleMs: 5_000,
};

/** Environment for a lane process: the caller's, minus every variable that would aim it elsewhere. */
export function laneEnvironment(
  extra: NodeJS.ProcessEnv,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("T3CODE_") ||
      key.startsWith("T3_") ||
      key.startsWith("VITE_") ||
      // The providers take their homes from the lane's settings, not from the caller's shell.
      key === "CODEX_HOME" ||
      key === "CLAUDE_CONFIG_DIR"
    ) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

type Role = "server" | "web";
type Presence = "gone" | "lane" | "unverified";

/** Where each role listens and which exact argument marks it, from the lane's manifest. */
const roleFacts = (state: LaneState, paths: LanePaths) => ({
  server: {
    option: "--base-dir",
    value: paths.home,
    port: state.serverPort,
    host: "127.0.0.1",
  },
  web: { option: "--port", value: String(state.webPort), port: state.webPort, host: "localhost" },
});

/**
 * `gone` when nothing with the recorded pid and start time runs (the pid may even belong to
 * another process now); `lane` when it runs and carries the exact argument that marks the lane's
 * process; `unverified` when it runs but does not look like the lane's process.
 */
function presenceOf(
  host: LaneHost,
  record: ProcessRecord | null,
  expected: { option: string; value: string },
): Presence {
  if (record === null) return "gone";
  const snapshot = host.inspect(record.pid);
  if (snapshot === null || snapshot.startedAt !== record.startedAt) return "gone";
  return commandHasOption(snapshot.command, expected.option, expected.value)
    ? "lane"
    : "unverified";
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
}

/** What of the lane is still alive: its processes, and anything still answering on its ports. */
async function survivors(host: LaneHost, state: LaneState, paths: LanePaths): Promise<string[]> {
  const found: Array<string> = [];
  for (const [role, facts] of Object.entries(roleFacts(state, paths)) as Array<
    [Role, ReturnType<typeof roleFacts>[Role]]
  >) {
    const presence = presenceOf(host, state[role], facts);
    if (presence !== "gone") found.push(`${role} pid ${state[role]?.pid} (${presence})`);
    if (await host.portListening(facts.port, facts.host)) {
      found.push(`something still answers on ${role} port ${facts.port}`);
    }
  }
  return found;
}

/**
 * Stops what the manifest records, each process only after its identity checks out, then waits
 * for the processes to be gone and the ports to be free. Returns what could not be stopped.
 */
async function stopRecorded(
  host: LaneHost,
  state: LaneState,
  paths: LanePaths,
  label: string,
): Promise<string[]> {
  const left: Array<string> = [];
  const facts = roleFacts(state, paths);
  for (const role of ["web", "server"] as const) {
    const record = state[role];
    const presence = presenceOf(host, record, facts[role]);
    if (record === null) continue;
    if (presence === "gone") {
      console.log(`lane ${label}: ${role} pid ${record.pid} is not running.`);
    } else if (presence === "unverified") {
      left.push(`${role} pid ${record.pid} is running but is not this lane's ${role}; left alone`);
    } else {
      try {
        host.kill(record.pid);
      } catch {
        // The check below decides whether it is gone.
      }
      if (await waitUntil(() => presenceOf(host, record, facts[role]) === "gone", host.settleMs)) {
        console.log(`lane ${label}: stopped ${role} pid ${record.pid}.`);
      } else {
        left.push(`${role} pid ${record.pid} is still running after being killed`);
      }
    }
  }
  for (const role of ["web", "server"] as const) {
    const { port, host: address } = facts[role];
    if (!(await waitUntil(async () => !(await host.portListening(port, address)), host.settleMs))) {
      left.push(`${role} port ${port} still answers; a process this tool did not record holds it`);
    }
  }
  return left;
}

export interface LaneOptions {
  readonly repo: string;
  readonly name: string;
  readonly dir: string | undefined;
  readonly source: string;
}

export async function startLane(options: LaneOptions, host: LaneHost = realHost): Promise<number> {
  const repo = NodePath.resolve(options.repo);
  const paths = lanePaths(repo, options.name, options.dir);
  const existing = readState(paths);
  if (existing === null) {
    if (!isEmptyOrMissing(paths.dir)) {
      console.error(
        `lane ${options.name}: ${paths.dir} already holds files and no lane.json. A lane only uses a new or empty folder; choose another --dir.`,
      );
      return 2;
    }
  } else {
    if (NodePath.resolve(existing.home) !== paths.home) {
      console.error(
        `lane ${options.name}: ${paths.state} belongs to a different home; not starting.`,
      );
      return 2;
    }
    const alive = await survivors(host, existing, paths);
    if (alive.length > 0) {
      console.error(
        `lane ${options.name}: still running (${alive.join("; ")}). Run "lane stop" first.`,
      );
      return 2;
    }
  }
  NodeFS.mkdirSync(paths.dir, { recursive: true });
  if (!NodeFS.existsSync(NodePath.join(paths.home, "userdata", "settings.json"))) {
    const seeded = seedLaneHome(NodePath.resolve(options.source), paths.home);
    console.log(
      `lane ${options.name}: codex home ${seeded.codexFiles.join(", ") || "empty"}${seeded.codexAuthSkipped ? " (login state not copied)" : ""}; claude home ${seeded.claudeFiles.join(", ") || "empty"}.`,
    );
  }
  let state: LaneState = {
    kind: STATE_KIND,
    name: options.name,
    repo,
    home: paths.home,
    serverPort: await host.freePort(),
    webPort: await host.freePort(),
    server: null,
    web: null,
    startedAt: new Date().toISOString(),
  };
  // The manifest exists before any process does, and is rewritten after each spawn.
  writeState(paths, state);
  const abort = async (reason: string): Promise<number> => {
    console.error(`lane ${options.name}: ${reason}`);
    const left = await stopRecorded(host, state, paths, options.name);
    if (left.length > 0) {
      console.error(
        `lane ${options.name}: could not stop everything (${left.join("; ")}). The manifest at ${paths.state} still records it; fix that, then run "lane stop".`,
      );
    }
    return 1;
  };
  try {
    state = {
      ...state,
      server: await host.spawn(
        process.execPath,
        [
          "src/bin.ts",
          "serve",
          "--base-dir",
          paths.home,
          "--port",
          String(state.serverPort),
          "--host",
          "127.0.0.1",
          "--no-browser",
          "--dev-url",
          `http://localhost:${state.webPort}`,
        ],
        {
          cwd: NodePath.join(repo, "apps", "server"),
          env: laneEnvironment({}),
          log: paths.serverLog,
        },
      ),
    };
    writeState(paths, state);
  } catch (error) {
    return abort(error instanceof Error ? error.message : String(error));
  }
  try {
    state = {
      ...state,
      web: await host.spawn("vp", ["dev", "--port", String(state.webPort)], {
        cwd: NodePath.join(repo, "apps", "web"),
        env: laneEnvironment({
          PORT: String(state.webPort),
          T3CODE_PORT: String(state.serverPort),
          T3CODE_SINGLE_ORIGIN_DEV: "1",
        }),
        log: paths.webLog,
      }),
    };
    writeState(paths, state);
  } catch (error) {
    return abort(error instanceof Error ? error.message : String(error));
  }
  const serverUp = await host.waitForHttp(
    `http://127.0.0.1:${state.serverPort}/.well-known/t3/environment`,
    90_000,
  );
  const webUp = await host.waitForHttp(`http://localhost:${state.webPort}/`, 120_000);
  if (!serverUp || !webUp) {
    return abort(
      `server ${serverUp ? "up" : "NOT UP"} on ${state.serverPort}, web ${webUp ? "up" : "NOT UP"} on ${state.webPort}; stopping what this start spawned (logs: ${paths.serverLog}, ${paths.webLog}).`,
    );
  }
  console.log(
    `lane ${options.name}: server up on ${state.serverPort}, web up on ${state.webPort}. State: ${paths.state}`,
  );
  return 0;
}

export async function stopLane(options: LaneOptions, host: LaneHost = realHost): Promise<number> {
  const paths = lanePaths(options.repo, options.name, options.dir);
  const state = readState(paths);
  if (state === null) {
    console.error(`lane ${options.name}: no state at ${paths.state}.`);
    return 2;
  }
  const left = await stopRecorded(host, state, paths, options.name);
  for (const problem of left) console.error(`lane ${options.name}: ${problem}.`);
  return left.length > 0 ? 1 : 0;
}

export function laneStatus(options: LaneOptions, host: LaneHost = realHost): number {
  const paths = lanePaths(options.repo, options.name, options.dir);
  const state = readState(paths);
  if (state === null) {
    console.log(`lane ${options.name}: not started (${paths.state}).`);
    return 1;
  }
  const facts = roleFacts(state, paths);
  const server = presenceOf(host, state.server, facts.server);
  const web = presenceOf(host, state.web, facts.web);
  const word = (presence: Presence) =>
    presence === "lane" ? "running" : presence === "gone" ? "stopped" : "UNVERIFIED";
  console.log(
    `lane ${options.name}: server ${word(server)} (port ${state.serverPort}), web ${word(web)} (http://localhost:${state.webPort}), home ${state.home}`,
  );
  return server === "lane" && web === "lane" ? 0 : 1;
}

/**
 * Deletes what a stopped lane wrote: its home, logs, browser state and manifest. Anything else in
 * the folder is left alone, and the folder itself goes only when nothing is left in it.
 */
export async function removeLane(options: LaneOptions, host: LaneHost = realHost): Promise<number> {
  const paths = lanePaths(options.repo, options.name, options.dir);
  const state = readState(paths);
  if (state === null || NodePath.resolve(state.home) !== paths.home) {
    console.error(
      `lane ${options.name}: ${paths.dir} does not hold this lane's manifest; nothing removed.`,
    );
    return 2;
  }
  const alive = await survivors(host, state, paths);
  if (alive.length > 0) {
    console.error(`lane ${options.name}: still running (${alive.join("; ")}); stop it first.`);
    return 1;
  }
  for (const path of ownedPaths(paths)) NodeFS.rmSync(path, { recursive: true, force: true });
  const unrelated = NodeFS.readdirSync(paths.dir);
  if (unrelated.length === 0) {
    NodeFS.rmdirSync(paths.dir);
    console.log(`lane ${options.name}: removed ${paths.dir}.`);
  } else {
    console.log(
      `lane ${options.name}: removed the lane's files; ${paths.dir} kept because it also holds ${unrelated.length} other ${unrelated.length === 1 ? "entry" : "entries"}.`,
    );
  }
  return 0;
}

/** Mints a pairing for the lane and saves a signed-in browser state; the token is never printed. */
export async function pairLane(options: LaneOptions): Promise<number> {
  const repo = NodePath.resolve(options.repo);
  const paths = lanePaths(repo, options.name, options.dir);
  const state = readState(paths);
  if (state === null) {
    console.error(`lane ${options.name}: not started.`);
    return 2;
  }
  const minted = NodeChildProcess.spawnSync(
    process.execPath,
    ["src/bin.ts", "pair", "--base-dir", paths.home, "--ttl", "10m", "--label", "workflow-qa"],
    { cwd: NodePath.join(repo, "apps", "server"), env: laneEnvironment({}), encoding: "utf8" },
  );
  const token = /[#?&]token=([^\s&]+)/.exec(minted.stdout)?.[1];
  if (minted.status !== 0 || token === undefined) {
    console.error(`lane ${options.name}: could not mint a pairing (exit ${minted.status}).`);
    return 1;
  }
  const browser = await launchBrowser(repo, undefined);
  try {
    const context = await browser.newContext({});
    const page = await context.newPage();
    await page.goto(`http://localhost:${state.webPort}/pair#token=${token}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // The pairing page leaves for the app once the server accepts the token.
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
    await context.storageState({ path: paths.storageState });
    await context.close();
  } finally {
    await browser.close();
  }
  console.log(`lane ${options.name}: paired. Browser state: ${paths.storageState}`);
  return 0;
}

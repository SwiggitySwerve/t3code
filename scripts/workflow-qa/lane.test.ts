// @effect-diagnostics nodeBuiltinImport:off - the tests build real folders and git repositories.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  QA_PROFILES,
  buildLaneSettings,
  commandHasOption,
  isStaticCodexAuth,
  laneCodexConfig,
  laneEnvironment,
  laneSecretFiles,
  lanePaths,
  laneStatus,
  removeLane,
  seedLaneHome,
  spawnTracked,
  startLane,
  stopLane,
  type LaneHost,
  type LaneOptions,
  type ProcessRecord,
} from "./lane.ts";

const HOMES = { claude: "E:/lane/home/claude-proxy-home", codex: "E:/lane/home/codex-proxy-home" };

const devSettings = () => ({
  favorites: [{ provider: "cliproxy", model: "claude-haiku-5-5" }],
  idleCompaction: "onReturn",
  remoteAccess: { token: "must-not-be-copied" },
  defaultModelSelection: { instanceId: "cliproxy", model: "claude-haiku-5-5" },
  workflowPresets: {
    presets: [
      { id: "mine", name: "My preset", target: { providerInstanceId: "cliproxy", model: "x" } },
    ],
    defaultPresetId: "mine",
  },
  providerInstances: {
    cliproxy: {
      driver: "codex",
      enabled: true,
      config: {
        homePath: "C:/user/.codex",
        shadowHomePath: "C:/user/shadow",
        setupMode: "shadow",
        binaryPath: "C:/bin/codex.exe",
      },
    },
    claudeproxy: {
      driver: "claudeAgent",
      enabled: true,
      config: { homePath: "E:/dev/claude-proxy-home" },
    },
    fireworks: { driver: "codex", enabled: true },
    codex: { driver: "codex", enabled: false },
  },
});

/** The lane's provider instances by id, for ids the dev fixture does not type. */
const instances = (lane: { readonly providerInstances: object }): Record<string, unknown> =>
  lane.providerInstances as Record<string, unknown>;

const CODEX_TOML = [
  'model = "gpt-6.1-sol"',
  'model_provider = "cliproxy"',
  'approval_policy = "never"',
  "",
  "[model_providers.cliproxy]",
  'name = "CLIProxyAPI"',
  'base_url = "http://127.0.0.1:8317/v1"',
  'env_key = "CLIPROXY_KEY"',
  "",
  "[agents]",
  "max_threads = 16",
  "",
  "[mcp_servers.thing]",
  'bearer_token = "must-not-be-copied"',
  "",
  '[projects."E:/work"]',
  'trust_level = "trusted"',
].join("\n");

const sha = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");

const scratch: Array<string> = [];
const tempDir = (): string => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-qa-lane-"));
  scratch.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of scratch.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

/** A dev home on disk: settings, one saved variable, a Claude proxy home and a Codex home with history. */
function makeDevHome(
  root: string,
  auth: unknown = { auth_mode: "apikey", OPENAI_API_KEY: "sk-test" },
) {
  const encoded = Buffer.from("cliproxy").toString("base64url");
  const claudeHome = NodePath.join(root, "dev", "claude-proxy-home");
  const codexHome = NodePath.join(root, "dev", "codex-home");
  const secrets = NodePath.join(root, "dev", "userdata", "secrets");
  for (const directory of [
    secrets,
    NodePath.join(claudeHome, "projects"),
    NodePath.join(codexHome, "sessions"),
  ]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }
  const settings = devSettings();
  settings.providerInstances.claudeproxy.config.homePath = claudeHome;
  settings.providerInstances.cliproxy.config.homePath = codexHome;
  const write = (path: string, text: string) => NodeFS.writeFileSync(path, text);
  write(NodePath.join(root, "dev", "userdata", "settings.json"), JSON.stringify(settings));
  write(NodePath.join(root, "dev", "userdata", "statev2.sqlite"), "history");
  write(NodePath.join(secrets, `provider-env-${encoded}-KEY.bin`), "secret");
  write(NodePath.join(secrets, "server-signing-key.bin"), "signing");
  write(NodePath.join(claudeHome, "settings.json"), "{}");
  write(NodePath.join(claudeHome, "projects", "session.jsonl"), "history");
  write(NodePath.join(codexHome, "config.toml"), CODEX_TOML);
  write(NodePath.join(codexHome, "auth.json"), JSON.stringify(auth));
  write(NodePath.join(codexHome, "sessions", "run.jsonl"), "history");
  write(NodePath.join(codexHome, "thread_history_1.sqlite"), "history");
  write(NodePath.join(codexHome, "models_cache.json"), "{}");
  return { dev: NodePath.join(root, "dev"), codexHome, claudeHome, encoded };
}

describe("lane settings and home", () => {
  it("builds the settings from an allowlist, with lane-local provider homes", () => {
    const source = devSettings();
    const lane = buildLaneSettings(source, HOMES) as ReturnType<typeof devSettings>;
    expect(Object.keys(lane).sort()).toEqual([
      "defaultModelSelection",
      "providerInstances",
      "workflowPresets",
    ]);
    expect(lane.workflowPresets.presets.map((preset) => preset.id)).toEqual(
      QA_PROFILES.map((profile) => profile.id),
    );
    expect(lane.workflowPresets.defaultPresetId).toBe("qa-worker");
    // Both stock instances the app enables by default are written disabled; fireworks is gone.
    expect(Object.keys(lane.providerInstances).sort()).toEqual([
      "claudeAgent",
      "claudeproxy",
      "cliproxy",
      "codex",
    ]);
    expect(lane.providerInstances.codex).toEqual({ driver: "codex", enabled: false });
    expect(instances(lane).claudeAgent).toEqual({ driver: "claudeAgent", enabled: false });
    expect(lane.providerInstances.claudeproxy.config.homePath).toBe(HOMES.claude);
    expect(lane.providerInstances.cliproxy.config).toEqual({
      homePath: HOMES.codex,
      shadowHomePath: "",
      setupMode: "existing",
      binaryPath: "C:/bin/codex.exe",
    });
    expect(lane.defaultModelSelection).toEqual(source.defaultModelSelection);
    expect(source).toEqual(devSettings());
    const text = JSON.stringify(lane).toLowerCase();
    expect(text).not.toContain("gemini");
    expect(text).not.toContain("must-not-be-copied");
  });

  it("disables the stock instances whatever the dev home says about them", () => {
    // Codex enabled in the dev home, claudeAgent not mentioned at all: the app would switch
    // either on, and each would start in the user's default provider home.
    for (const codex of [
      { driver: "codex", enabled: true },
      { driver: "codex", config: { enabled: true, homePath: "C:/user/.codex" } },
      { driver: "codex" },
    ]) {
      const source = devSettings();
      source.providerInstances.codex = codex as typeof source.providerInstances.codex;
      const lane = buildLaneSettings(source, HOMES) as ReturnType<typeof devSettings>;
      expect(lane.providerInstances.codex).toEqual({ driver: "codex", enabled: false });
      expect(instances(lane).claudeAgent).toEqual({
        driver: "claudeAgent",
        enabled: false,
      });
    }
    const bare = buildLaneSettings({}, HOMES) as ReturnType<typeof devSettings>;
    expect(bare.providerInstances).toEqual({
      codex: { driver: "codex", enabled: false },
      claudeAgent: { driver: "claudeAgent", enabled: false },
    });
  });
  it("leaves the default model out when no lane provider serves it", () => {
    const source = devSettings();
    source.defaultModelSelection = { instanceId: "fireworks", model: "m" };
    expect(buildLaneSettings(source, HOMES)).not.toHaveProperty("defaultModelSelection");
  });

  it("copies only the saved variables of the lane's providers", () => {
    const encoded = (id: string) => Buffer.from(id).toString("base64url");
    expect(
      laneSecretFiles([
        `provider-env-${encoded("cliproxy")}-KEY.bin`,
        `provider-env-${encoded("fireworks")}-KEY.bin`,
        "server-signing-key.bin",
        "cloud-link-ed25519-key-pair.bin",
        `provider-env-${encoded("claudeproxy")}-TOKEN.bin`,
      ]),
    ).toEqual([
      `provider-env-${encoded("cliproxy")}-KEY.bin`,
      `provider-env-${encoded("claudeproxy")}-TOKEN.bin`,
    ]);
  });

  it("keeps only the proxy configuration of a Codex config.toml", () => {
    const lane = laneCodexConfig(CODEX_TOML);
    expect(lane).toContain('model = "gpt-6.1-sol"');
    expect(lane).toContain('model_provider = "cliproxy"');
    expect(lane).toContain("[model_providers.cliproxy]");
    expect(lane).toContain('env_key = "CLIPROXY_KEY"');
    for (const left of [
      "approval_policy",
      "[agents]",
      "mcp_servers",
      "must-not-be-copied",
      "projects",
    ]) {
      expect(lane).not.toContain(left);
    }
  });

  it("copies a static API key but never login state", () => {
    expect(isStaticCodexAuth('{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}')).toBe(true);
    expect(isStaticCodexAuth('{"OPENAI_API_KEY":"sk-test"}')).toBe(true);
    expect(
      isStaticCodexAuth(
        '{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"refresh_token":"r"}}',
      ),
    ).toBe(false);
    expect(isStaticCodexAuth('{"auth_mode":"apikey","OPENAI_API_KEY":"k","tokens":{}}')).toBe(
      false,
    );
    expect(isStaticCodexAuth("not json")).toBe(false);
  });

  it("seeds a lane home without history, other secrets or any change to the source", () => {
    const root = tempDir();
    const { dev, codexHome, encoded } = makeDevHome(root);
    const sourceFiles = [
      NodePath.join(dev, "userdata", "settings.json"),
      NodePath.join(codexHome, "config.toml"),
      NodePath.join(codexHome, "auth.json"),
    ];
    const before = sourceFiles.map(sha);
    const home = NodePath.join(root, "lane", "home");

    const report = seedLaneHome(dev, home);

    expect(NodeFS.readdirSync(home).sort()).toEqual([
      "claude-proxy-home",
      "codex-proxy-home",
      "userdata",
    ]);
    expect(NodeFS.readdirSync(NodePath.join(home, "userdata")).sort()).toEqual([
      "secrets",
      "settings.json",
    ]);
    expect(NodeFS.readdirSync(NodePath.join(home, "userdata", "secrets"))).toEqual([
      `provider-env-${encoded}-KEY.bin`,
    ]);
    expect(NodeFS.readdirSync(NodePath.join(home, "claude-proxy-home"))).toEqual(["settings.json"]);
    // The Codex home has the proxy configuration and its key, and none of the dev home's history.
    expect(NodeFS.readdirSync(NodePath.join(home, "codex-proxy-home")).sort()).toEqual([
      "auth.json",
      "config.toml",
    ]);
    expect(report).toEqual({
      codexFiles: ["config.toml", "auth.json"],
      codexAuthSkipped: false,
      claudeFiles: ["settings.json"],
    });
    const lane = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, "userdata", "settings.json"), "utf8"),
    );
    expect(lane.providerInstances.cliproxy.config.homePath).toBe(
      NodePath.join(home, "codex-proxy-home"),
    );
    expect(sourceFiles.map(sha)).toEqual(before);
  });

  it("does not copy a Codex login that holds rotating tokens", () => {
    const root = tempDir();
    const { dev } = makeDevHome(root, {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { refresh_token: "rotating" },
    });
    const home = NodePath.join(root, "lane", "home");
    const report = seedLaneHome(dev, home);
    expect(report.codexAuthSkipped).toBe(true);
    expect(NodeFS.readdirSync(NodePath.join(home, "codex-proxy-home"))).toEqual(["config.toml"]);
  });

  it("keeps a lane beside the checkout by default and rejects unsafe names", () => {
    const paths = lanePaths(NodePath.join("E:", "work", "t3code"), "u14-smoke", undefined);
    expect(paths.dir).toBe(
      NodePath.resolve(NodePath.join("E:", "work", "t3code-qa-lanes", "u14-smoke")),
    );
    expect(() => lanePaths("repo", "../escape", undefined)).toThrow(/lowercase letters/);
  });

  it("removes the caller's configuration directories from a lane process's environment", () => {
    const env = laneEnvironment(
      { PORT: "1" },
      {
        PATH: "p",
        CODEX_HOME: "C:/live",
        CLAUDE_CONFIG_DIR: "C:/live",
        T3CODE_HOME: "x",
        VITE_HTTP_URL: "x",
      },
    );
    expect(env).toEqual({ PATH: "p", PORT: "1" });
  });
});

describe("process identity", () => {
  it("matches an option only as an exact argument", () => {
    expect(commandHasOption("vp dev --port 5733", "--port", "5733")).toBe(true);
    expect(commandHasOption("vp dev --port 57331", "--port", "5733")).toBe(false);
    expect(commandHasOption("vp dev --port 5733 --x", "--port", "5733")).toBe(true);
    expect(
      commandHasOption(
        'node bin.ts --base-dir "E:\\a b\\home" --port 1',
        "--base-dir",
        "E:\\a b\\home",
      ),
    ).toBe(true);
    expect(
      commandHasOption("node bin.ts --base-dir E:\\lane\\home2", "--base-dir", "E:\\lane\\home"),
    ).toBe(false);
  });

  it("reports a command that cannot be started instead of crashing", async () => {
    const root = tempDir();
    await expect(
      spawnTracked("definitely-not-a-workflow-qa-command", [], {
        cwd: root,
        env: process.env,
        log: NodePath.join(root, "x.log"),
      }),
    ).rejects.toThrow(/Could not start definitely-not-a-workflow-qa-command/);
  });
});
/** A host with no real processes: it records what the lane asks of the machine. */
function fakeHost(overrides: Partial<LaneHost> = {}) {
  const processes = new Map<number, { startedAt: string; command: string }>();
  const killed: Array<number> = [];
  const listening = new Set<number>();
  let nextPid = 7000;
  let nextPort = 41000;
  const host: LaneHost = {
    spawn: async (command, args) => {
      const pid = nextPid++;
      const record: ProcessRecord = { pid, startedAt: `t${pid}` };
      processes.set(pid, { startedAt: record.startedAt, command: `${command} ${args.join(" ")}` });
      return record;
    },
    inspect: (pid) => processes.get(pid) ?? null,
    kill: (pid) => {
      killed.push(pid);
      processes.delete(pid);
    },
    portListening: async (port) => listening.has(port),
    waitForHttp: async () => true,
    freePort: async () => nextPort++,
    settleMs: 0,
    ...overrides,
  };
  return { host, processes, killed, listening };
}

function laneFixture() {
  const root = tempDir();
  const { dev } = makeDevHome(root);
  const options: LaneOptions = {
    repo: NodePath.join(root, "checkout"),
    name: "qa",
    dir: NodePath.join(root, "lane"),
    source: dev,
  };
  const paths = lanePaths(options.repo, options.name, options.dir);
  const state = () => JSON.parse(NodeFS.readFileSync(paths.state, "utf8"));
  return { root, options, paths, state };
}

describe("lane ownership of its folder", () => {
  it("refuses a folder that already holds files and has no lane manifest", async () => {
    const { options, paths } = laneFixture();
    NodeFS.mkdirSync(paths.dir);
    NodeFS.writeFileSync(NodePath.join(paths.dir, "evidence.png"), "keep");
    const fake = fakeHost();
    const spawn = vi.spyOn(fake.host, "spawn");

    expect(await startLane(options, fake.host)).toBe(2);

    expect(spawn).not.toHaveBeenCalled();
    expect(NodeFS.readdirSync(paths.dir)).toEqual(["evidence.png"]);
    expect(await removeLane(options, fake.host)).toBe(2);
    expect(NodeFS.readFileSync(NodePath.join(paths.dir, "evidence.png"), "utf8")).toBe("keep");
  });

  it("removes only what the lane wrote and keeps unrelated files and the folder", async () => {
    const { options, paths } = laneFixture();
    const fake = fakeHost();
    expect(await startLane(options, fake.host)).toBe(0);
    NodeFS.writeFileSync(paths.storageState, "{}");
    NodeFS.writeFileSync(NodePath.join(paths.dir, "notes.md"), "mine");
    expect(await stopLane(options, fake.host)).toBe(0);

    expect(await removeLane(options, fake.host)).toBe(0);

    expect(NodeFS.readdirSync(paths.dir)).toEqual(["notes.md"]);
  });

  it("removes the folder too when nothing else is in it", async () => {
    const { options, paths } = laneFixture();
    const fake = fakeHost();
    expect(await startLane(options, fake.host)).toBe(0);
    expect(await stopLane(options, fake.host)).toBe(0);
    expect(await removeLane(options, fake.host)).toBe(0);
    expect(NodeFS.existsSync(paths.dir)).toBe(false);
  });

  it("will not touch a lane.json that this tool did not write", async () => {
    const { options, paths } = laneFixture();
    NodeFS.mkdirSync(paths.dir);
    NodeFS.writeFileSync(paths.state, JSON.stringify({ home: paths.home }));
    await expect(removeLane(options, fakeHost().host)).rejects.toThrow(/not a lane manifest/);
    expect(NodeFS.existsSync(paths.state)).toBe(true);
  });
});

describe("lane start and stop", () => {
  it("records both processes with their start times, and reports them", async () => {
    const { options, state } = laneFixture();
    const fake = fakeHost();
    expect(await startLane(options, fake.host)).toBe(0);
    expect(state().server).toEqual({ pid: 7000, startedAt: "t7000" });
    expect(state().web).toEqual({ pid: 7001, startedAt: "t7001" });
    expect(laneStatus(options, fake.host)).toBe(0);
    expect(await stopLane(options, fake.host)).toBe(0);
    expect(fake.killed).toEqual([7001, 7000]);
    expect(laneStatus(options, fake.host)).toBe(1);
  });

  it("starts nothing more when the server cannot be started, and says why", async () => {
    const { options, state } = laneFixture();
    const fake = fakeHost({ spawn: async () => Promise.reject(new Error("no node")) });
    expect(await startLane(options, fake.host)).toBe(1);
    expect(state().server).toBeNull();
    expect(state().web).toBeNull();
    expect(fake.killed).toEqual([]);
  });

  it("stops the server it started when the web server cannot be started", async () => {
    const { options, state } = laneFixture();
    const base = fakeHost();
    let calls = 0;
    const host: LaneHost = {
      ...base.host,
      spawn: async (command, args, spawnOptions) => {
        calls += 1;
        if (calls === 2) throw new Error("Could not start vp: spawn vp ENOENT");
        return base.host.spawn(command, args, spawnOptions);
      },
    };
    expect(await startLane(options, host)).toBe(1);
    // The server's identity was written before the web spawn, so the failed start can reach it.
    expect(state().server).toEqual({ pid: 7000, startedAt: "t7000" });
    expect(base.killed).toEqual([7000]);
    expect(base.processes.size).toBe(0);
  });

  it("stops both processes when the servers never answer", async () => {
    const { options } = laneFixture();
    const fake = fakeHost({ waitForHttp: async () => false });
    expect(await startLane(options, fake.host)).toBe(1);
    expect(fake.killed).toEqual([7001, 7000]);
    expect(fake.processes.size).toBe(0);
  });

  it("keeps the manifest and says what is left when a stop does not take", async () => {
    const { options, paths } = laneFixture();
    const fake = fakeHost({ waitForHttp: async () => false });
    const stubborn: LaneHost = { ...fake.host, kill: () => {} };
    expect(await startLane(options, stubborn)).toBe(1);
    expect(NodeFS.existsSync(paths.state)).toBe(true);
    expect(fake.processes.size).toBe(2);
    // The recorded identity still lets a later stop finish the job.
    expect(await stopLane(options, fake.host)).toBe(0);
    expect(fake.processes.size).toBe(0);
  });

  it("refuses to start again while either process or port survives", async () => {
    const { options } = laneFixture();
    const fake = fakeHost();
    expect(await startLane(options, fake.host)).toBe(0);
    // Only the web process is left: the server has gone.
    fake.processes.delete(7000);
    const spawn = vi.spyOn(fake.host, "spawn");
    expect(await startLane(options, fake.host)).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    // A port that still answers refuses it too, even with both processes gone.
    fake.processes.clear();
    fake.listening.add(41000);
    expect(await startLane(options, fake.host)).toBe(2);
    fake.listening.clear();
    expect(await startLane(options, fake.host)).toBe(0);
  });

  it("leaves a process alone whose pid was reused or that is not the lane's", async () => {
    const { options } = laneFixture();
    const fake = fakeHost();
    expect(await startLane(options, fake.host)).toBe(0);
    // The server's pid now belongs to another process (new start time); the web pid keeps its
    // start time but its command line no longer carries the lane's port.
    fake.processes.set(7000, { startedAt: "other", command: "notepad" });
    fake.processes.set(7001, { startedAt: "t7001", command: "vp dev --port 1" });
    expect(await stopLane(options, fake.host)).toBe(1);
    expect(fake.killed).toEqual([]);
  });

  it("does not take a longer port number for the lane's web server", async () => {
    const { options, state } = laneFixture();
    const fake = fakeHost();
    expect(await startLane(options, fake.host)).toBe(0);
    const { webPort } = state();
    fake.processes.set(7001, { startedAt: "t7001", command: `vp dev --port ${webPort}1` });
    expect(laneStatus(options, fake.host)).toBe(1);
    expect(await stopLane(options, fake.host)).toBe(1);
    expect(fake.killed).toEqual([7000]);
  });
});

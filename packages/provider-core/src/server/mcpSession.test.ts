import { describe, expect, it } from "vite-plus/test";
import {
  hasMemberToolset,
  isWorkflowMemberSession,
  withAgentDeviceEnvironment,
} from "./mcpSession.ts";

describe("workflow member credentials", () => {
  it("treats a thread credential without orchestration as a member's", () => {
    expect(hasMemberToolset(new Set(["worktree", "pull-requests"]))).toBe(true);
    expect(hasMemberToolset(new Set())).toBe(true);
    expect(hasMemberToolset(new Set(["orchestration", "worktree"]))).toBe(false);
  });

  it("leaves sessions that record no capabilities unchanged", () => {
    expect(hasMemberToolset(undefined)).toBe(false);
    expect(isWorkflowMemberSession(undefined)).toBe(false);
    expect(isWorkflowMemberSession({})).toBe(false);
    expect(isWorkflowMemberSession({ capabilities: new Set(["worktree"]) })).toBe(true);
  });
});

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

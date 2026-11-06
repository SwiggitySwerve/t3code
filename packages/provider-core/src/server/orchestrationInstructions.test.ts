// @effect-diagnostics nodeBuiltinImport:off -- Pins the upstream instruction bytes without a second prose definition.
import * as NodeCrypto from "node:crypto";
import { assert, describe, expect, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3OrchestrationInstructions,
  t3OrchestrationModelFamily,
  t3OrchestrationSections,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });
});

// Digest goldens of the rendered text; the evals in evals/mcp-tool-use cover its behaviour.
describe("model-family orchestration instructions", () => {
  it.each([
    ["claude-opus-4-6", "anthropic"],
    ["anthropic/claude-sonnet-4-6", "anthropic"],
    ["gpt-5.4", "openai"],
    ["openai/gpt-5.4", "openai"],
    ["unknown-model", "generic"],
  ] as const)("recognizes selected model %s", (model, family) => {
    expect(t3OrchestrationModelFamily(model)).toBe(family);
  });

  it("refreshes ACP instructions on a family change only when workflows are on", () => {
    const state = {
      interactionMode: "default",
      hasT3Mcp: true,
      hasDeviceTools: false,
      workflows: true,
      model: "gpt-5.4",
    } as const;
    const changed = { ...state, model: "claude-sonnet-4-6" };
    expect(
      t3AcpPromptWithInstructions({ prompt: "Continue.", state: changed, previousState: state }),
    ).toContain("- Claude Code: native subagents");
    expect(
      t3AcpPromptWithInstructions({
        prompt: "Continue.",
        state: { ...changed, model: "claude-opus-4-6" },
        previousState: changed,
      }),
    ).toBe("Continue.");
    expect(
      t3AcpPromptWithInstructions({
        prompt: "Continue.",
        state: { ...changed, workflows: false },
        previousState: { ...state, workflows: false },
      }),
    ).toBe("Continue.");
  });

  it.each([
    ["", "cf1af62c0623d1e72324de218d53c7e33a90ab135057b48d01f4d870e61f0a54", 3876],
    [
      "anthropic/claude-opus-4-6",
      "8d96ee8d50d8ec858cd1d3e2ce234bcea001f73bfce7d841ccf8cf7aa1ba15ec",
      3960,
    ],
    ["openai/gpt-5.4", "cf1af62c0623d1e72324de218d53c7e33a90ab135057b48d01f4d870e61f0a54", 3876],
    ["unknown-model", "cf1af62c0623d1e72324de218d53c7e33a90ab135057b48d01f4d870e61f0a54", 3876],
  ] as const)("renders the reviewed text for selected model %s", (model, digest, bytes) => {
    const rendered = t3OrchestrationInstructions(true, model);
    expect(NodeCrypto.createHash("sha256").update(rendered).digest("hex")).toBe(digest);
    expect(Buffer.byteLength(rendered, "utf8")).toBe(bytes);
    for (const section of t3OrchestrationSections(true, model)) {
      expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(4_000);
    }
    expect(t3OrchestrationInstructions(false, model)).toBe(T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });
});

describe("workflow instruction gate", () => {
  it("uses upstream's exact instructions by default and restores workflow guidance on opt-in", () => {
    expect(
      NodeCrypto.createHash("sha256").update(T3_CODE_ORCHESTRATION_INSTRUCTIONS).digest("hex"),
    ).toBe("4935b0aa0005a6e9e36f0113cbc4cdd0959ab040cdc6b76de33d87e84a8940e0");
    expect(t3OrchestrationSystemPrompt(true, false)).toBe(T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    expect(t3OrchestrationSystemPrompt(true, false, false)).toBe(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
    );
    const enabled = t3OrchestrationSystemPrompt(true, false, true);
    for (const addition of ["workflow_start", "graph_review"]) {
      expect(T3_CODE_ORCHESTRATION_INSTRUCTIONS).not.toContain(addition);
      expect(enabled).toContain(addition);
    }
  });
});

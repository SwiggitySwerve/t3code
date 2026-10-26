import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { T3_CODE_ORCHESTRATION_SECTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  describe.each([
    { model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" },
  ])("with runtime $model", (runtime) => {
    it.each([undefined, { browser: true, device: true }])(
      "keeps every entry within Codex's per-entry cap with tools %j",
      (availability) => {
        const context = buildCodexAdditionalContext(runtime, availability);

        for (const [key, entry] of Object.entries(context)) {
          // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
          const bytes = Buffer.byteLength(entry.value, "utf8");
          const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
          NodeAssert.ok(
            bytes <= limit,
            `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
          );
        }
      },
    );
  });
});

describe("Codex runtime context", () => {
  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("Codex orchestration context", () => {
  it("routes same-child follow-ups to t3_thread_send and independent reviews to delegate_task", () => {
    const orchestration = Object.entries(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }))
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(
      orchestration.includes(
        "For independent T3 delegated review rounds, call `delegate_task` again.",
      ),
    );
    NodeAssert.ok(
      orchestration.includes(
        "For a follow-up that needs the same child's conversation, use `t3_thread_send` on its `childThreadId`.",
      ),
    );
    NodeAssert.ok(!orchestration.includes("Do not use `t3_thread_send`"));
  });
});

describe("Codex context for workflow members", () => {
  it("drops only the orchestration entries and shrinks the context", () => {
    const runtime = { model: "gpt-6.1-sol" };
    const full = buildCodexAdditionalContext(runtime, { browser: false, device: false });
    const member = buildCodexAdditionalContext(runtime, { browser: false, device: false }, false);

    NodeAssert.deepEqual(Object.keys(member), ["t3_code_runtime"]);
    NodeAssert.deepEqual(member.t3_code_runtime, full.t3_code_runtime);
    const bytes = (context: typeof full) =>
      Object.values(context).reduce(
        (sum, entry) => sum + Buffer.byteLength(entry.value, "utf8"),
        0,
      );
    NodeAssert.equal(
      bytes(full) - bytes(member),
      T3_CODE_ORCHESTRATION_SECTIONS.reduce(
        (sum, section) => sum + Buffer.byteLength(section, "utf8"),
        0,
      ),
    );
  });

  it("keeps browser and device text under their own availability", () => {
    const member = buildCodexAdditionalContext(
      { model: "gpt-6.1-sol" },
      { browser: true, device: true },
      false,
    );
    NodeAssert.deepEqual(Object.keys(member), ["t3_code_runtime", "t3_code_tools"]);
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).t3_code_runtime!.value;
}

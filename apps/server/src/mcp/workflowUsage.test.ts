import { describe, expect, it } from "vite-plus/test";
import type { TurnTokenUsage } from "@t3tools/contracts";
import {
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
  makeCodexTurnTokenUsageState,
} from "../provider/CodexTurnTokenUsage.ts";
import { normalizeClaudeTurnTokenUsage } from "../provider/ClaudeTurnTokenUsage.ts";
import { aggregateWorkflowUsage } from "./workflowUsage.ts";

const complete: TurnTokenUsage = {
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  inputTokens: 100,
  cachedInputTokens: 40,
  cacheCreationTokens: 10,
  outputTokens: 20,
};

describe("workflow usage", () => {
  it("sums all turns and retry attempts, with caches included in input", () => {
    expect(aggregateWorkflowUsage([complete, complete, complete])).toEqual({
      status: "complete",
      inputTokens: 300,
      cachedInputTokens: 120,
      cacheCreationTokens: 30,
      uncachedInputTokens: 150,
      outputTokens: 60,
      totalTokens: 360,
    });
  });
  it("keeps known lower bounds when another attempt or turn lacks usage", () => {
    expect(aggregateWorkflowUsage([complete, undefined])).toMatchObject({
      status: "partial",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    expect(
      aggregateWorkflowUsage([
        { usageStatus: "partial", usageScope: "main_agent", hasSubagents: false, outputTokens: 7 },
      ]),
    ).toMatchObject({
      status: "partial",
      inputTokens: null,
      cachedInputTokens: null,
      cacheCreationTokens: null,
      uncachedInputTokens: null,
      outputTokens: 7,
      totalTokens: 7,
    });
  });
  it("never reports missing usage as zero, including cancelled and unsupported providers", () => {
    for (const records of [
      [],
      [undefined],
      [{ usageStatus: "unavailable", usageScope: "main_agent", hasSubagents: false }],
    ] as const) {
      expect(aggregateWorkflowUsage(records)).toEqual({
        status: "unavailable",
        inputTokens: null,
        cachedInputTokens: null,
        cacheCreationTokens: null,
        uncachedInputTokens: null,
        outputTokens: null,
        totalTokens: null,
      });
    }
    expect(
      aggregateWorkflowUsage([
        {
          ...complete,
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
        },
      ]),
    ).toMatchObject({ status: "complete", totalTokens: 0 });
  });
  it("does not invent cache counts when the provider omits them", () => {
    expect(
      aggregateWorkflowUsage([
        {
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: false,
          inputTokens: 8,
          outputTokens: 2,
        },
      ]),
    ).toMatchObject({
      status: "complete",
      cachedInputTokens: null,
      cacheCreationTokens: null,
      uncachedInputTokens: null,
    });
  });
  it("counts Codex multi-response turns rather than the final response's context occupancy", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    const response = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens: 0,
    });
    const first = response(100, 40, 10);
    const last = response(120, 60, 20);
    accumulateCodexTurnTokenUsage(state, "turn", {
      total: first,
      last: first,
      modelContextWindow: 200_000,
    });
    accumulateCodexTurnTokenUsage(state, "turn", {
      total: response(220, 100, 30),
      last,
      modelContextWindow: 200_000,
    });
    const usage = aggregateWorkflowUsage([completeCodexTurnTokenUsage(state, "turn", true)]);
    expect(usage).toMatchObject({
      inputTokens: 220,
      cachedInputTokens: 100,
      uncachedInputTokens: 120,
      outputTokens: 30,
      totalTokens: 250,
    });
    const oldUsedTokensSum = [last].reduce((sum, context) => sum + context.totalTokens, 0);
    expect(oldUsedTokensSum).toBe(140);
    expect(usage.totalTokens).not.toBe(oldUsedTokensSum);
  });
  it("uses Claude normalized input including cache reads and creation", () => {
    const usage = normalizeClaudeTurnTokenUsage(
      {
        subtype: "success",
        usage: {
          input_tokens: 50,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
          output_tokens: 20,
        },
      },
      false,
      "completed",
    );
    expect(aggregateWorkflowUsage([usage])).toMatchObject({
      status: "complete",
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      uncachedInputTokens: 50,
      outputTokens: 20,
      totalTokens: 120,
    });
  });
});

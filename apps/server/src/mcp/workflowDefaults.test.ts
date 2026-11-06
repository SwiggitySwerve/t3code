import { describe, expect, it } from "@effect/vitest";
import type { ProviderOptionDescriptor } from "@t3tools/contracts";

import { type DefaultCandidate, defaultJudge, defaultRouting } from "./workflowDefaults.ts";

const effort = (id: string, values: ReadonlyArray<string>): ProviderOptionDescriptor => ({
  id,
  label: "Reasoning",
  type: "select",
  options: values.map((value) => ({ id: value, label: value })),
});
const candidate = (
  providerInstanceId: string,
  model: string,
  price: readonly [number, number] | null,
  optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>,
): DefaultCandidate => ({
  providerInstanceId,
  model,
  listPrice: price === null ? null : { inputUsdPerMTok: price[0], outputUsdPerMTok: price[1] },
  optionDescriptors,
});
const claudeEfforts = [effort("effort", ["default", "low", "medium", "high", "max"])];
const codexEfforts = [effort("reasoningEffort", ["minimal", "low", "medium", "high", "xhigh"])];
const at = (providerInstanceId: string, model: string, options: ReadonlyArray<unknown>) => ({
  providerInstanceId,
  model,
  options,
  inheritOptions: false,
});
const route = (candidates: ReadonlyArray<DefaultCandidate>, callerInstanceId = "codex") =>
  defaultRouting({ candidates, pricingAvailable: true, callerInstanceId });

describe("defaultRouting", () => {
  const catalog = [
    candidate("claude", "claude-sonnet-4-6", [3, 15], claudeEfforts),
    candidate("codex", "gpt-5.4", [1.25, 10], codexEfforts),
    candidate("claude", "claude-haiku-4-5", [1, 5], claudeEfforts),
    candidate("codex", "gpt-5.4-mini", [0.25, 2], codexEfforts),
    candidate("claude", "claude-opus-4-6", [5, 25], claudeEfforts),
  ];

  it("climbs from the cheapest model's lowest effort to the next pricier model of its family", () => {
    expect(route(catalog)).toEqual({
      routing: {
        target: at("codex", "gpt-5.4-mini", [{ id: "reasoningEffort", value: "low" }]),
        retries: [
          at("codex", "gpt-5.4-mini", [{ id: "reasoningEffort", value: "high" }]),
          at("codex", "gpt-5.4", [{ id: "reasoningEffort", value: "high" }]),
        ],
        judges: [
          {
            family: "gpt",
            target: at("codex", "gpt-5.4-mini", [{ id: "reasoningEffort", value: "medium" }]),
          },
          {
            family: "claude",
            target: at("claude", "claude-haiku-4-5", [{ id: "effort", value: "medium" }]),
          },
        ],
      },
    });
  });

  it("judges with the cheapest model of a family none of the worker's attempts uses", () => {
    const result = route(catalog);
    if (!("routing" in result)) throw new Error("expected a routing");
    expect(defaultJudge(result.routing, ["gpt-5.4-mini", "gpt-5.4"])?.model).toBe(
      "claude-haiku-4-5",
    );
    expect(defaultJudge(result.routing, ["claude-sonnet-4-6"])?.model).toBe("gpt-5.4-mini");
    // Fails closed: a worker that runs on every enabled family gets no default judge.
    expect(defaultJudge(result.routing, ["gpt-5.4", "claude-haiku-4-5"])).toBeUndefined();
  });

  it("never treats an unpriced model as cheapest", () => {
    const result = route([
      candidate("codex", "gpt-5.4-nano", null, codexEfforts),
      candidate("claude", "haiku", null, claudeEfforts),
      ...catalog,
    ]);
    expect("routing" in result && result.routing.target.model).toBe("gpt-5.4-mini");
    expect(route([candidate("codex", "gpt-5.4-nano", null)])).toEqual({
      unavailable: expect.stringContaining("No enabled model has a list price"),
    });
  });

  it("sets no defaults without a price table, and says so", () => {
    expect(
      defaultRouting({ candidates: catalog, pricingAvailable: false, callerInstanceId: "codex" }),
    ).toEqual({ unavailable: expect.stringContaining("No list prices are at hand") });
  });

  it("skips rungs a model cannot offer and placeholder models", () => {
    // One effort, no sibling: no retries at all, and no effort option without a descriptor.
    expect(
      route([
        candidate("cursor", "auto", [0, 0]),
        candidate("codex", "gpt-5.4", [0.5, 1], [effort("reasoningEffort", ["xhigh"])]),
        candidate("claude", "claude-haiku-4-5", [1, 5]),
      ]),
    ).toEqual({
      routing: {
        target: at("codex", "gpt-5.4", []),
        retries: [],
        judges: [
          { family: "gpt", target: at("codex", "gpt-5.4", []) },
          { family: "claude", target: at("claude", "claude-haiku-4-5", []) },
        ],
      },
    });
  });

  it("breaks price ties by the caller's instance, then by model, never by catalog order", () => {
    const tied = [
      candidate("codex-b", "gpt-5.4-mini", [0.25, 2]),
      candidate("codex-a", "gpt-5.4-mini", [0.25, 2]),
    ];
    const first = (callerInstanceId: string, candidates = tied) => {
      const result = route(candidates, callerInstanceId);
      return "routing" in result ? result.routing.target.providerInstanceId : undefined;
    };
    expect(first("claude")).toBe("codex-a");
    expect(first("claude", tied.toReversed())).toBe("codex-a");
    expect(first("codex-b")).toBe("codex-b");
  });
});

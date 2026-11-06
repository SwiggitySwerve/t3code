import { describe, expect, it } from "@effect/vitest";
import type { ProviderOptionDescriptor } from "@t3tools/contracts";

import * as Option from "effect/Option";

import {
  type DefaultCandidate,
  decodeDefaultRouting,
  defaultJudge,
  defaultRouting,
  storedDefaults,
} from "./workflowDefaults.ts";

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

describe("effort options of other drivers", () => {
  it.each([
    ["OpenCode", "variant"],
    ["Pi", "thinking"],
  ])("climbs a %s model through its %s option", (_driver, id) => {
    const result = route([
      candidate("driver", "grok-4.7-mini", [1, 2], [effort(id, ["low", "medium", "high"])]),
    ]);
    expect(result).toEqual({
      routing: {
        target: at("driver", "grok-4.7-mini", [{ id, value: "low" }]),
        retries: [at("driver", "grok-4.7-mini", [{ id, value: "high" }])],
        judges: [
          { family: "grok", target: at("driver", "grok-4.7-mini", [{ id, value: "medium" }]) },
        ],
      },
    });
  });

  it("ignores a boolean thinking toggle", () => {
    const toggle: ProviderOptionDescriptor = { id: "thinking", label: "Thinking", type: "boolean" };
    const result = route([candidate("claude", "claude-haiku-4-5", [1, 5], [toggle])]);
    expect("routing" in result && result.routing.target.options).toEqual([]);
  });
});

describe("qualified model ids", () => {
  const catalog = [
    candidate("grok", "grok-4.7", [0.2, 0.5]),
    candidate("openrouter", "xai/grok-4.7", [0.3, 0.6]),
    candidate("openrouter", "anthropic/claude-haiku-4-5", [1, 5]),
    candidate("claude", "claude-sonnet-4-6", [3, 15]),
    candidate("openrouter", "openai/gpt-5.4-mini", [2, 8]),
    candidate("codex", "gpt-5.4", [2.5, 10]),
  ];
  const routing = (() => {
    const result = route(catalog);
    if (!("routing" in result)) throw new Error("expected a routing");
    return result.routing;
  })();

  it("groups a vendor-qualified model with its bare family", () => {
    expect(routing.judges.map((judge) => judge.family)).toEqual(["grok", "claude", "gpt"]);
    // The pricier "xai/grok-4.7" is the next rung of grok-4.7's family, not another family's judge.
    expect(routing.retries.map((rung) => rung.model)).toEqual(["xai/grok-4.7"]);
  });

  it.each([
    ["grok-4.7", "anthropic/claude-haiku-4-5"],
    ["xai/grok-4.7", "anthropic/claude-haiku-4-5"],
    ["claude-sonnet-4-6", "grok-4.7"],
    ["anthropic/claude-haiku-4-5", "grok-4.7"],
    ["gpt-5.4", "grok-4.7"],
    ["openai/gpt-5.4-mini", "grok-4.7"],
  ])("never judges %s with its own family: %s", (worker, judge) => {
    expect(defaultJudge(routing, [worker])?.model).toBe(judge);
  });

  it("gives no judge when every family is in use, however qualified", () => {
    expect(
      defaultJudge(routing, ["xai/grok-4.7", "anthropic/claude-haiku-4-5", "openai/gpt-5.4"]),
    ).toBeUndefined();
  });
});

describe("a judge's effort", () => {
  const judgeOf = (values: ReadonlyArray<string>) => {
    const result = route([
      candidate("codex", "gpt-5.4-mini", [1, 1], [effort("reasoningEffort", values)]),
    ]);
    return "routing" in result ? result.routing.judges[0]?.target.options : undefined;
  };
  const value = (effortValue: string) => [{ id: "reasoningEffort", value: effortValue }];

  it("is medium when offered, wherever it sits among the choices", () => {
    expect(judgeOf(["low", "medium"])).toEqual(value("medium"));
    expect(judgeOf(["medium", "high"])).toEqual(value("medium"));
    expect(judgeOf(["low", "medium", "high"])).toEqual(value("medium"));
    expect(judgeOf(["minimal", "low", "medium", "high", "xhigh"])).toEqual(value("medium"));
  });

  it("is the offered effort nearest medium, the lower on a tie, when medium is not offered", () => {
    expect(judgeOf(["low", "high"])).toEqual(value("low"));
    expect(judgeOf(["high"])).toEqual(value("high"));
    expect(judgeOf(["low"])).toEqual(value("low"));
  });
});

describe("stored defaults", () => {
  it("round-trips the routing and the reason there is none", () => {
    const result = route([candidate("codex", "gpt-5.4-mini", [1, 1])]);
    expect(decodeDefaultRouting(storedDefaults(result))).toEqual(Option.some(result));
    const none = { unavailable: "no prices" };
    expect(decodeDefaultRouting(storedDefaults(none))).toEqual(Option.some(none));
    expect(Option.isNone(decodeDefaultRouting({ target: 1 }))).toBe(true);
  });
});

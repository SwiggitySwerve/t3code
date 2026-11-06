/**
 * T3's cheap-first defaults for an agent the coordinator left without a target, derived from base
 * list prices, model families and effort options: cheapest model at low effort, more effort, the
 * next pricier model of its family, and a judge of another family. Unpriced models never qualify.
 */
import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { concreteModelFamily } from "./workflowAdvisory.ts";
import { MAX_RETRY_TARGETS } from "./workflowLimits.ts";

const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["reasoningEffort", "effort"]);
/** Effort words from least to most. Defaults stay within low..high, the range ladders measured. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LOWEST_DEFAULT_EFFORT = EFFORT_ORDER.indexOf("low");
const HIGHEST_DEFAULT_EFFORT = EFFORT_ORDER.indexOf("high");

/** One model an enabled, healthy provider instance of the project offers. */
export interface DefaultCandidate {
  readonly providerInstanceId: string;
  readonly model: string;
  /** Base list price in USD per million tokens; null when the table does not know the model. */
  readonly listPrice: {
    readonly inputUsdPerMTok: number;
    readonly outputUsdPerMTok: number;
  } | null;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor> | undefined;
}

/** A default as a target a coordinator could have written: exactly these options, no others. */
export interface DefaultTarget {
  readonly providerInstanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  readonly inheritOptions: false;
}

export interface DefaultRouting {
  readonly target: DefaultTarget;
  readonly retries: ReadonlyArray<DefaultTarget>;
  /** The cheapest model of each family, cheapest first, as a judge at its middle effort. */
  readonly judges: ReadonlyArray<{ readonly family: string; readonly target: DefaultTarget }>;
}

export type DefaultRoutingResult =
  | { readonly routing: DefaultRouting }
  | { readonly unavailable: string };

interface PricedCandidate {
  readonly candidate: DefaultCandidate;
  readonly family: string;
  readonly price: number;
  readonly effort: { readonly id: string; readonly values: ReadonlyArray<string> } | undefined;
}

/** The effort option and its offered values within low..high, least first. */
function effortRange(descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined) {
  const descriptor = descriptors?.find(
    (candidate) =>
      candidate.type === "select" &&
      (EFFORT_OPTION_IDS.has(candidate.id) || candidate.role === "reasoning"),
  );
  if (descriptor?.type !== "select") return undefined;
  const rank = (id: string) => EFFORT_ORDER.indexOf(id as (typeof EFFORT_ORDER)[number]);
  const values = descriptor.options
    .map((choice) => choice.id)
    .filter((id) => rank(id) >= LOWEST_DEFAULT_EFFORT && rank(id) <= HIGHEST_DEFAULT_EFFORT)
    .toSorted((a, b) => rank(a) - rank(b));
  return values.length === 0 ? undefined : { id: descriptor.id, values };
}

/** Locale-independent, so the same catalog picks the same defaults on every host. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function targetAt(entry: PricedCandidate, effort: string | undefined): DefaultTarget {
  return {
    providerInstanceId: entry.candidate.providerInstanceId,
    model: entry.candidate.model,
    options:
      effort === undefined || entry.effort === undefined
        ? []
        : [{ id: entry.effort.id, value: effort }],
    inheritOptions: false,
  };
}

/**
 * The default ladder and judges for a project's models, or why there are none. Ties on price go
 * to the caller's provider instance, then by model and instance id, so catalog order never
 * decides.
 */
export function defaultRouting(input: {
  readonly candidates: ReadonlyArray<DefaultCandidate>;
  /** False when no list price table is at hand at all. */
  readonly pricingAvailable: boolean;
  readonly callerInstanceId: string;
}): DefaultRoutingResult {
  if (!input.pricingAvailable)
    return {
      unavailable:
        "No list prices are at hand, so T3 sets no default targets: an agent without one runs on your own model.",
    };
  const seen = new Set<string>();
  const priced = input.candidates
    .flatMap((candidate): ReadonlyArray<PricedCandidate> => {
      const family = concreteModelFamily(candidate.model);
      if (family === undefined || candidate.listPrice === null) return [];
      return [
        {
          candidate,
          family,
          price: candidate.listPrice.inputUsdPerMTok + candidate.listPrice.outputUsdPerMTok,
          effort: effortRange(candidate.optionDescriptors),
        },
      ];
    })
    .toSorted(
      (a, b) =>
        a.price - b.price ||
        Number(b.candidate.providerInstanceId === input.callerInstanceId) -
          Number(a.candidate.providerInstanceId === input.callerInstanceId) ||
        byCodeUnit(a.candidate.model, b.candidate.model) ||
        byCodeUnit(a.candidate.providerInstanceId, b.candidate.providerInstanceId),
    )
    // The same model on a second instance is no further rung.
    .filter((entry) => {
      if (seen.has(entry.candidate.model)) return false;
      seen.add(entry.candidate.model);
      return true;
    });
  const cheapest = priced[0];
  if (cheapest === undefined)
    return {
      unavailable:
        "No enabled model has a list price, so T3 sets no default targets: an agent without one runs on your own model.",
    };
  const efforts = cheapest.effort?.values ?? [];
  const next = priced.find((entry) => entry !== cheapest && entry.family === cheapest.family);
  const retries = [
    ...(efforts.length > 1 ? [targetAt(cheapest, efforts.at(-1))] : []),
    ...(next === undefined ? [] : [targetAt(next, next.effort?.values.at(-1))]),
  ].slice(0, MAX_RETRY_TARGETS);
  const judges: Array<DefaultRouting["judges"][number]> = [];
  for (const entry of priced) {
    if (judges.some((judge) => judge.family === entry.family)) continue;
    const values = entry.effort?.values ?? [];
    judges.push({
      family: entry.family,
      target: targetAt(entry, values[Math.floor((values.length - 1) / 2)]),
    });
  }
  return { routing: { target: targetAt(cheapest, efforts[0]), retries, judges } };
}

/** The cheapest default judge of a family none of the worker's attempts uses. */
export function defaultJudge(
  routing: DefaultRouting,
  workerModels: ReadonlyArray<string>,
): DefaultTarget | undefined {
  const families = new Set(workerModels.map((model) => concreteModelFamily(model)));
  return routing.judges.find((judge) => !families.has(judge.family))?.target;
}

/** The advisory note for a judgment check that gets no default judge. */
export const NO_DEFAULT_JUDGE_NOTE =
  "no enabled model of another family, so T3 sets no default judge: it runs on its worker's target.";

const DefaultTargetSchema = Schema.Struct({
  providerInstanceId: Schema.String,
  model: Schema.String,
  options: Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.String })),
  inheritOptions: Schema.Literal(false),
});

/** How a script workflow stores the defaults frozen at its start, so a resume runs the same ones. */
export const decodeDefaultRouting = Schema.decodeUnknownOption(
  Schema.Struct({
    target: DefaultTargetSchema,
    retries: Schema.Array(DefaultTargetSchema),
    judges: Schema.Array(Schema.Struct({ family: Schema.String, target: DefaultTargetSchema })),
  }),
);

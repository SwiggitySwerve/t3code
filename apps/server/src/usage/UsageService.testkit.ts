import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { RateTable } from "./usagePricing.ts";
import * as UsageService from "./UsageService.ts";

/** A usage service that only lists prices: this table, or none as when no table can be read. */
export const layerRates = (table: RateTable = new Map()) =>
  Layer.mock(UsageService.UsageService)({
    peekRates: Effect.succeed({
      table,
      pricing: {
        status: table.size === 0 ? "unavailable" : "cached",
        source: "test-rates",
        fetchedAt: null,
        knownModels: table.size,
      },
    }),
  });

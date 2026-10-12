import { narrowedEnvironmentId } from "@t3tools/client-runtime/state/environment-selection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  homeShowsFullPageEmptyState,
  resolveHomeEnvironmentSelection,
} from "./home-environment-selection";

const fedora = EnvironmentId.make("fedora");
const environments = [
  {
    environmentId: fedora,
    isEnabled: true,
    connectionState: "connected" as const,
  },
  {
    environmentId: EnvironmentId.make("switched-off"),
    isEnabled: false,
    connectionState: "available" as const,
  },
];

describe("resolveHomeEnvironmentSelection", () => {
  it("shows all environments without a stored choice", () => {
    const resolved = resolveHomeEnvironmentSelection(undefined, environments, true);
    expect(resolved.status).toBe("all");
    expect(narrowedEnvironmentId(resolved)).toBeNull();
  });

  it("restores the stored environment", () => {
    expect(resolveHomeEnvironmentSelection("fedora", environments, true)).toEqual({
      status: "active",
      environmentId: fedora,
      online: true,
    });
  });

  it("reports a removed or switched-off environment as missing and keeps the list narrowed", () => {
    for (const stored of ["removed", "switched-off"]) {
      const resolved = resolveHomeEnvironmentSelection(stored, environments, true);
      expect(resolved.status).toBe("missing");
      expect(narrowedEnvironmentId(resolved)).toBe(stored);
    }
  });

  it("stays narrowed while connections load", () => {
    const resolved = resolveHomeEnvironmentSelection("fedora", [], false);
    expect(resolved).toEqual({ status: "pending", environmentId: fedora });
  });
});

describe("homeShowsFullPageEmptyState", () => {
  it("shows the full-page empty state when there is nothing to list", () => {
    expect(homeShowsFullPageEmptyState({ hasAnyThreads: false, environmentMissing: false })).toBe(
      true,
    );
  });

  it("keeps the list, and its recovery action, when the selected environment is missing", () => {
    expect(homeShowsFullPageEmptyState({ hasAnyThreads: false, environmentMissing: true })).toBe(
      false,
    );
  });

  it("keeps the list when there are threads", () => {
    expect(homeShowsFullPageEmptyState({ hasAnyThreads: true, environmentMissing: false })).toBe(
      false,
    );
  });
});

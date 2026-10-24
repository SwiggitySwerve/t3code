import { describe, expect, it } from "vite-plus/test";
import { workflowGraphFailureSummary } from "./workflowGraphResult.ts";

describe("workflowGraphFailureSummary", () => {
  it("keeps failed labels, reasons and skipped counts without dumping records", () => {
    expect(
      workflowGraphFailureSummary([
        { label: "Build", status: "failed", reason: "No provider" },
        { label: "Test", status: "skipped" },
        { label: "Independent", status: "passed" },
      ]),
    ).toBe("Graph failed: 1 node failed, 1 skipped. Build: No provider");
  });
  it("bounds long failures and keeps a count of omitted failures", () => {
    const result = workflowGraphFailureSummary(
      Array.from({ length: 10 }, (_, index) => ({
        label: `Node ${index}`,
        status: "failed",
        reason: "x".repeat(10000),
      })),
    );
    expect(result.length).toBeLessThan(850);
    expect(result).toContain("10 nodes failed");
    expect(result).toContain("7 more failed nodes");
    expect(workflowGraphFailureSummary([{ label: "Unknown", status: "failed" }])).toContain(
      "No failure reason recorded.",
    );
  });
});

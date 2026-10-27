/** Kept self-contained because the graph driver also runs it inside QuickJS. */
export function workflowGraphFailureSummary(
  nodes: ReadonlyArray<{
    readonly label: string;
    readonly status: string;
    readonly reason?: string | undefined;
  }>,
): string {
  const failed = nodes.filter((node) => node.status === "failed");
  const skipped = nodes.filter((node) => node.status === "skipped").length;
  const details = failed.slice(0, 3).map((node) => {
    const reason = node.reason?.trim();
    return `${node.label}: ${reason ? (reason.length > 240 ? `${reason.slice(0, 237)}...` : reason) : "No failure reason recorded."}`;
  });
  const remaining = failed.length - details.length;
  return [
    `Graph failed: ${failed.length} ${failed.length === 1 ? "node" : "nodes"} failed${skipped > 0 ? `, ${skipped} skipped` : ""}.`,
    ...details,
    ...(remaining > 0 ? [`${remaining} more failed ${remaining === 1 ? "node" : "nodes"}.`] : []),
  ].join(" ");
}

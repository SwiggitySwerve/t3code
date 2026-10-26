import { workingTreeChangedFileCount } from "@t3tools/shared/git";

type ChangedFiles = Parameters<typeof workingTreeChangedFileCount>[0];

/** "1 file changed" / "9,000 files changed": every changed file, listed or not. */
export function changedFilesLabel(workingTree: ChangedFiles | null | undefined): string {
  const count = workingTree ? workingTreeChangedFileCount(workingTree) : 0;
  return `${count.toLocaleString()} file${count === 1 ? "" : "s"} changed`;
}

/** "9,000 changed" for the compact thread menu. */
export function compactChangedLabel(workingTree: ChangedFiles): string {
  return `${workingTreeChangedFileCount(workingTree).toLocaleString()} changed`;
}

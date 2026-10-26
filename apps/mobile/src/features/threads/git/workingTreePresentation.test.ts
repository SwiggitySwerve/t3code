import { describe, expect, it } from "vite-plus/test";

import { changedFilesLabel, compactChangedLabel } from "./workingTreePresentation.ts";

const file = (path: string) => ({ path, insertions: 1, deletions: 0 });

describe("changed file labels", () => {
  const small = { files: [file("a.ts")] };
  // The server lists 1,000 files and reports the rest in omittedFileCount.
  const large = {
    files: Array.from({ length: 1_000 }, (_, i) => file(`f${i}.ts`)),
    omittedFileCount: 8_000,
  };

  it("counts a status with no omitted files by its listed files", () => {
    expect(changedFilesLabel(small)).toBe("1 file changed");
    expect(changedFilesLabel({ files: [file("a.ts"), file("b.ts")] })).toBe("2 files changed");
    expect(changedFilesLabel(null)).toBe("0 files changed");
    expect(compactChangedLabel(small)).toBe("1 changed");
  });

  // regression: these showed "1,000 files changed" for a 9,000-file change set.
  it("includes the omitted files in the total", () => {
    expect(changedFilesLabel(large)).toBe("9,000 files changed");
    expect(compactChangedLabel(large)).toBe("9,000 changed");
    expect(changedFilesLabel({ files: [file("a.ts")], omittedFileCount: 1 })).toBe(
      "2 files changed",
    );
  });
});

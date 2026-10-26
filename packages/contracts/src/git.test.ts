import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
  VcsStatusLocalResult,
} from "./git.ts";

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeVcsStatusLocalResult = Schema.decodeUnknownSync(VcsStatusLocalResult);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("GitRunStackedActionInput", () => {
  it("preserves leading and trailing whitespace in file paths", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      filePaths: [" leading.txt", "trailing.txt "],
    });

    expect(parsed.filePaths).toEqual([" leading.txt", "trailing.txt "]);
  });
});

describe("VcsStatusLocalResult workingTree", () => {
  const status = (workingTree: Record<string, unknown>) => ({
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: "main",
    hasWorkingTreeChanges: true,
    workingTree,
  });
  const files = [{ path: "a.ts", insertions: 1, deletions: 0 }];

  it("treats the omitted file count as optional", () => {
    const small = decodeVcsStatusLocalResult(status({ files, insertions: 1, deletions: 0 }));
    expect(small.workingTree.omittedFileCount).toBeUndefined();
    const large = decodeVcsStatusLocalResult(
      status({ files, omittedFileCount: 8_000, insertions: 9_000, deletions: 0 }),
    );
    expect(large.workingTree.omittedFileCount).toBe(8_000);
  });

  it("rejects a negative or fractional omitted file count", () => {
    for (const omittedFileCount of [-1, 1.5]) {
      expect(() =>
        decodeVcsStatusLocalResult(
          status({ files, omittedFileCount, insertions: 1, deletions: 0 }),
        ),
      ).toThrow();
    }
  });
});

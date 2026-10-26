import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { memo } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";

type Branched = { readonly branch: string };
type GitActionInput = {
  featureBranch?: boolean;
  threadId?: string;
  action: string;
  filePaths?: string[];
};
type Toast = { actionProps?: { onClick: () => void } };

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  shell: null as Branched | null,
  detail: null as Branched | null,
  draft: null as (Branched & { worktreePath: null; envMode: "local" }) | null,
  branch: "main",
  isDefaultRef: false,
  actions: [] as { scope: { cwd: string | null }; input: GitActionInput }[],
  metadataRequests: [] as { environmentId: string; branch: string }[],
  toasts: [] as Toast[],
  afterGitAction: undefined as (() => void) | undefined,
  workingTreeRoot: undefined as string | undefined,
  files: [{ path: "file.ts", insertions: 1, deletions: 0 }],
  omittedFileCount: undefined as number | undefined,
  totals: { insertions: 1, deletions: 0 },
  editorOpens: [] as { environmentId: string; input: { cwd: string; editor: string } }[],
}));

vi.mock(import("~/state/session"), async (original) => {
  const hasScope = (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: { threadId: string } | null) =>
    ref === null || state.shell === null ? null : { ...state.shell, id: ref.threadId }) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null || state.detail === null
      ? null
      : { projection: { thread: state.detail } }) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: {
      sourceControlProviders: [],
      isRepo: true,
      refName: state.branch,
      isDefaultRef: state.isDefaultRef,
      hasPrimaryRemote: true,
      hasWorkingTreeChanges: true,
      workingTree: {
        ...(state.workingTreeRoot === undefined ? {} : { rootPath: state.workingTreeRoot }),
        files: state.files,
        ...(state.omittedFileCount === undefined
          ? {}
          : { omittedFileCount: state.omittedFileCount }),
        ...state.totals,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    },
    error: null,
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { shellEnvironment } = await import("~/state/shell");
  return {
    ...(await original()),
    // Only the thread's branch metadata update and editor opens are observed here.
    useAtomCommand: ((command: unknown, options: unknown) =>
      options === "thread branch metadata update"
        ? async ({
            environmentId,
            input,
          }: {
            environmentId: string;
            input: { branch: string };
          }) => {
            state.metadataRequests.push({ environmentId, branch: input.branch });
            if (!state.scopes.has(AuthOrchestrationOperateScope))
              return AsyncResult.failure(Cause.fail(new Error("Task denied")));
            if (state.shell) state.shell = { branch: input.branch };
            if (state.detail) state.detail = { branch: input.branch };
            return AsyncResult.success(undefined);
          }
        : command === shellEnvironment.openInEditor
          ? async (request: (typeof state.editorOpens)[number]) => {
              state.editorOpens.push(request);
              return AsyncResult.success(undefined);
            }
          : async () => AsyncResult.success(undefined)) as never,
  };
});
// The preferred-editor flow needs one editor the environment reports as installed.
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => ({ availableEditors: ["cursor"] }));
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
  };
});
vi.mock(import("~/lib/sourceControlActions"), async (original) => ({
  ...(await original()),
  useSourceControlActionRunning: () => false,
  useGitStackedAction: ((scope: { cwd: string | null }) => ({
    run: async (input: GitActionInput) => {
      state.actions.push({ scope, input });
      if (input.featureBranch) state.branch = "feature";
      state.afterGitAction?.();
      return {
        _tag: "Success",
        value: {
          branch: input.featureBranch
            ? { status: "created", name: "feature" }
            : { status: "skipped_not_requested" },
          toast: {
            title: "Committed",
            description: "Committed",
            cta: {
              kind: "run_action",
              label: "Push & create PR",
              action: { kind: "commit_push_pr" },
            },
          },
        },
      };
    },
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => async () => {}) as never,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: ((toast: Toast) => {
        state.toasts.push(toast);
        return "toast";
      }) as never,
    },
  };
});

import { useComposerDraftStore } from "~/composerDraftStore";
import GitActionsControl from "./GitActionsControl";

const MemoGitActionsControl = memo(GitActionsControl);

function control(thread = "thread", cwd = "/repo") {
  return (
    <MemoGitActionsControl
      gitCwd={cwd}
      activeThreadRef={{
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make(thread),
      }}
    />
  );
}

const button = (name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

// The mocked modules read `state`, so every test starts by resetting all of it.
function setup() {
  state.scopes = new Set([AuthSourceControlWriteScope]);
  state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
  state.shell = { branch: "main" };
  state.detail = null;
  state.draft = null;
  state.branch = "main";
  state.isDefaultRef = false;
  state.actions = [];
  state.metadataRequests = [];
  state.toasts = [];
  state.afterGitAction = undefined;
  state.workingTreeRoot = undefined;
  state.files = [{ path: "file.ts", insertions: 1, deletions: 0 }];
  state.omittedFileCount = undefined;
  state.totals = { insertions: 1, deletions: 0 };
  state.editorOpens = [];
  useComposerDraftStore.setState({
    getDraftSession: () => state.draft as never,
    getDraftThreadByRef: () => state.draft as never,
    setDraftThreadContext: (_target, input) => {
      if (state.draft && input.branch) state.draft = { ...state.draft, branch: input.branch };
    },
  });
}

describe("Git action targets across thread navigation", () => {
  const quickAction = () => button(/^Commit, push & /);

  it("runs a retained PR toast in the thread that produced it", async () => {
    setup();
    await using screen = await render(control("first", "/first"));
    await userEvent.click(quickAction());
    await vi.waitFor(() => expect(state.toasts.some((toast) => toast.actionProps)).toBe(true));
    const toast = state.toasts.find((toast) => toast.actionProps)!;

    await screen.rerender(control("second", "/second"));
    await act(async () => toast.actionProps!.onClick());

    expect(state.actions.at(-1)).toMatchObject({
      scope: { cwd: "/first" },
      input: { threadId: "first", action: "commit_push_pr" },
    });
  });
});

describe("Commit dialog file selection", () => {
  async function openCommitDialog() {
    await userEvent.click(button("Git action options"));
    await userEvent.click(page.getByRole("menuitem", { name: "Commit", exact: true }));
    return page.getByRole("dialog");
  }

  it("commits only the checked files when every changed file is listed", async () => {
    setup();
    state.files = [
      { path: "kept.ts", insertions: 1, deletions: 0 },
      { path: "dropped.ts", insertions: 2, deletions: 0 },
    ];
    state.totals = { insertions: 3, deletions: 0 };
    await using _screen = await render(control());
    const dialog = await openCommitDialog();

    await expect.element(dialog.getByText("more files not listed")).not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Edit", exact: true }));
    await userEvent.click(dialog.getByRole("checkbox").nth(2));
    await userEvent.click(dialog.getByRole("button", { name: "Commit", exact: true }));

    await vi.waitFor(() =>
      expect(state.actions.at(-1)?.input).toMatchObject({
        action: "commit",
        filePaths: ["kept.ts"],
      }),
    );
  });

  // regression: a partial `filePaths` list would silently drop the files the server omitted.
  it("says how many files are not listed and commits everything for a very large change set", async () => {
    setup();
    state.files = [
      { path: "a.ts", insertions: 1, deletions: 0 },
      { path: "b.ts", insertions: 1, deletions: 0 },
    ];
    state.omittedFileCount = 8_000;
    state.totals = { insertions: 9_000, deletions: 12 };
    await using _screen = await render(control());
    const dialog = await openCommitDialog();

    await expect.element(dialog.getByText("and 8,000 more files not listed")).toBeVisible();
    await expect
      .element(dialog.getByText(/choosing individual files is unavailable/i))
      .toBeVisible();
    // The file count covers the two listed files and the 8,000 omitted ones.
    await expect.element(dialog.getByText("(8,002)")).toBeVisible();
    // Exact totals for every change, not the sum of the two listed files.
    await expect.element(dialog.getByText("+9,000")).toBeVisible();
    await expect.element(dialog.getByText("-12")).toBeVisible();
    await expect
      .element(dialog.getByRole("button", { name: "Edit", exact: true }))
      .not.toBeInTheDocument();
    expect(dialog.getByRole("checkbox").elements()).toHaveLength(0);

    await userEvent.click(dialog.getByRole("button", { name: "Commit", exact: true }));

    await vi.waitFor(() => expect(state.actions.at(-1)?.input.action).toBe("commit"));
    expect(state.actions.at(-1)?.input).not.toHaveProperty("filePaths");
  });

  // regression: a file unchecked while every file was listed is committed once a live status
  // update reports omitted files, so the row must not still say "Excluded".
  it("shows no file as excluded after a status update omits files", async () => {
    setup();
    state.files = [
      { path: "kept.ts", insertions: 1, deletions: 0 },
      { path: "dropped.ts", insertions: 2, deletions: 0 },
    ];
    state.totals = { insertions: 3, deletions: 0 };
    await using screen = await render(control());
    const dialog = await openCommitDialog();

    await userEvent.click(dialog.getByRole("button", { name: "Edit", exact: true }));
    await userEvent.click(dialog.getByRole("checkbox").nth(2));
    await userEvent.click(dialog.getByRole("button", { name: "Done", exact: true }));
    await expect.element(dialog.getByText("Excluded")).toBeVisible();

    state.omittedFileCount = 5;
    state.totals = { insertions: 8, deletions: 0 };
    await screen.rerender(control());

    await expect.element(dialog.getByText("and 5 more files not listed")).toBeVisible();
    await expect.element(dialog.getByText("Excluded")).not.toBeInTheDocument();
    await expect.element(dialog.getByText("+2")).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Commit", exact: true }));

    await vi.waitFor(() => expect(state.actions.at(-1)?.input.action).toBe("commit"));
    expect(state.actions.at(-1)?.input).not.toHaveProperty("filePaths");
  });
});

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type PressableProps = {
  children?: ReactNode;
  disabled?: boolean;
  accessible?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
};

const harness = vi.hoisted(() => ({
  granted: new Set<string>(),
  turn: null as unknown,
  threadSubagents: [] as ReadonlyArray<unknown>,
  stop: vi.fn(),
  announce: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: 26 },
  AccessibilityInfo: { announceForAccessibility: harness.announce },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: PressableProps) => (
    <button
      type="button"
      data-accessible={props.accessible === true ? "true" : undefined}
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={() => props.onPress?.()}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityLiveRegion,
  }: {
    children?: ReactNode;
    accessibilityLiveRegion?: "polite" | "assertive" | "off";
  }) => <span aria-live={accessibilityLiveRegion}>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/GlassSurface", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-screens", () => ({
  ScreenStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-haptics", () => ({ selectionAsync: () => {} }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: (name: string, params: unknown) => ({ type: "REPLACE", name, params }) },
  useNavigation: () => ({ dispatch: () => {}, goBack: () => {} }),
}));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidSheetHeader: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: () => null,
  nativeHeaderScrollEdgeEffects: () => undefined,
}));
vi.mock("../../native/ThemedScreenStack", () => ({
  NativeHeader: () => null,
  NativeScreen: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (
    atom: { readonly kind: string; readonly environmentId?: string },
    select?: (thread: unknown) => unknown,
  ) =>
    atom.kind === "permission"
      ? harness.granted.has(atom.environmentId ?? "")
      : atom.kind === "thread"
        ? select?.({ projection: { subagents: harness.threadSubagents } })
        : harness.turn,
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    stopWorkflow: {
      permissionAtom: (environmentId: string) => ({ kind: "permission", environmentId }),
    },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.stop }));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: {
    turnSubagentsAtom: () => ({ kind: "turn" }),
    threadAtom: () => ({ kind: "thread" }),
  },
}));
vi.mock("./thread-inspector-navigation", () => ({ useOpenThreadInspector: () => () => false }));
vi.mock("./SubagentRow", () => ({
  SubagentRow: ({ subagent }: { subagent: { title: string; status: string } }) => (
    <span>{`${subagent.title} ${subagent.status}`}</span>
  ),
}));

import { ThreadAgentsSheet } from "./ThreadAgentsSheet";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const PARENT = ThreadId.make("parent");

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "workflow-row",
    threadId: PARENT,
    title: "Ship the release",
    prompt: "export const meta = {}",
    model: null,
    status: "running",
    origin: "app_owned",
    driver: "codex",
    providerInstanceId: "codex",
    childThreadId: null,
    parentNodeId: "parent-node",
    startedAt: null,
    completedAt: null,
    result: null,
    workflow: { name: "ship", phases: [], agents: [] },
    ...overrides,
  };
}

/** A task the workflow started: app-owned, parented to the workflow row, with a thread of its own. */
function member(overrides: Record<string, unknown> = {}) {
  return agent({
    id: "member-row",
    title: "Member task",
    parentNodeId: "workflow-row",
    childThreadId: "member-thread",
    workflow: undefined,
    ...overrides,
  });
}

function turnOf(...subagents: ReadonlyArray<unknown>) {
  return {
    runId: null,
    turnActive: true,
    subagents,
    liveCount: subagents.length,
    settledCount: 0,
  };
}

let root: Root;
let container: HTMLElement;

const sheetProps = {
  route: { params: { environmentId: ENVIRONMENT, threadId: PARENT } },
} as unknown as ComponentProps<typeof ThreadAgentsSheet>;

function show() {
  act(() => root.render(<ThreadAgentsSheet {...sheetProps} />));
}

/** The projection the sheet reads: the workflow row as it is now, with the members that run. */
function project(workflow: ReturnType<typeof agent>, ...members: ReadonlyArray<unknown>) {
  harness.turn = turnOf(workflow);
  harness.threadSubagents = [workflow, ...members];
}

const stopButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Stop workflow Ship the release"]');
const notice = () => container.querySelector('[aria-live="polite"]');

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  harness.granted = new Set([ENVIRONMENT]);
  project(agent());
  harness.stop.mockReset();
  harness.stop.mockResolvedValue(AsyncResult.success(undefined));
  harness.announce.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
});

describe("ThreadAgentsSheet workflow Stop", () => {
  it("stops a running workflow T3 runs, not just its status", async () => {
    show();

    expect(container.textContent).toContain("Ship the release running");
    act(() => stopButton()?.click());
    await flush();

    expect(harness.stop).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT,
      input: { threadId: PARENT, subagentId: "workflow-row" },
    });
    expect(stopButton()?.closest('[data-accessible="true"]')).toBeNull();
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "offers no Stop once the workflow is %s",
    (status) => {
      project(agent({ status }));

      show();

      expect(container.textContent).toContain(`Ship the release ${status}`);
      expect(stopButton()).toBeNull();
    },
  );

  it("offers no Stop without the operate grant", () => {
    harness.granted = new Set();

    show();

    expect(stopButton()).toBeNull();
  });

  it("offers no Stop on a subagent that is not a workflow T3 runs", () => {
    harness.turn = turnOf(
      agent({ id: "native", origin: "provider_native", workflow: undefined }),
      agent({ id: "task", childThreadId: "task-thread", workflow: undefined }),
    );

    show();

    expect(container.querySelector('button[aria-label^="Stop workflow"]')).toBeNull();
  });

  it("keeps a retry after a partial stop cancels the workflow while a member still runs", async () => {
    let settle: (result: AsyncResult.AsyncResult<void, Error>) => void = () => {};
    harness.stop.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    project(agent(), member());
    show();
    act(() => stopButton()?.click());

    project(agent({ status: "cancelled" }), member());
    show();
    settle(AsyncResult.failure(Cause.fail(new Error("offline"))));
    await flush();

    expect(notice()?.textContent).toBe("Could not stop the workflow. Try again.");
    expect(stopButton()?.disabled).toBe(false);

    act(() => stopButton()?.click());
    await flush();

    expect(harness.stop).toHaveBeenLastCalledWith({
      environmentId: ENVIRONMENT,
      input: { threadId: PARENT, subagentId: "workflow-row" },
    });
  });

  it("offers no Stop on a stopped workflow whose members still run, unless a stop was asked for here", () => {
    project(agent({ status: "cancelled" }), member());

    show();

    expect(container.textContent).toContain("Ship the release cancelled");
    expect(stopButton()).toBeNull();
  });
});

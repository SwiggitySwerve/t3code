import { EnvironmentId, ThreadId, type OrchestrationV2Subagent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
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
  liveAgents: [] as ReadonlyArray<unknown> | undefined,
  stop: vi.fn(),
  announce: vi.fn(),
  platform: "android",
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
  AccessibilityInfo: { announceForAccessibility: harness.announce },
  Platform: {
    get OS() {
      return harness.platform;
    },
  },
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
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string, params: unknown) => ({ type: "PUSH", name, params }) },
  useIsFocused: () => true,
  useNavigation: () => ({ dispatch: () => {} }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (
    atom: { readonly kind: string; readonly environmentId?: string },
    select?: (thread: unknown) => unknown,
  ) =>
    atom.kind === "permission"
      ? harness.granted.has(atom.environmentId ?? "")
      : atom.kind === "thread"
        ? select?.({ projection: { subagents: harness.liveAgents } })
        : null,
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    stopWorkflow: {
      permissionAtom: (environmentId: string) => ({ kind: "permission", environmentId }),
    },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.stop }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => ({ kind: "config" }) },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => ({ kind: "thread" }) },
}));
vi.mock("./SubagentRow", () => ({
  SubagentRow: ({ subagent }: { subagent: { title: string; status: string } }) => (
    <span>{`${subagent.title} ${subagent.status}`}</span>
  ),
}));
vi.mock("./work-log-layout", () => ({
  WorkLogBlock: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { ThreadSubagentGroup } from "./thread-subagent-group";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const PARENT = ThreadId.make("parent");
const STOP_FAILED = "Could not stop the workflow. Try again.";

type Status = OrchestrationV2Subagent["status"];

function row(overrides: Record<string, unknown> = {}) {
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
  return row({
    id: "member-row",
    title: "Member task",
    parentNodeId: "workflow-row",
    childThreadId: "member-thread",
    workflow: undefined,
    ...overrides,
  });
}

function turnItem(status: Status, overrides: Record<string, unknown> = {}) {
  return {
    projectedItem: {
      item: {
        type: "subagent",
        id: "item-1",
        threadId: PARENT,
        subagentId: "workflow-row",
        title: "Ship the release",
        origin: "app_owned",
        driver: "codex",
        providerInstanceId: "codex",
        childThreadId: null,
        prompt: "export const meta = {}",
        result: null,
        status,
        startedAt: null,
        completedAt: null,
        ...overrides,
      },
    },
  };
}

let root: Root;
let container: HTMLElement;

function show(...items: ReadonlyArray<ReturnType<typeof turnItem>>) {
  act(() =>
    root.render(
      <ThreadSubagentGroup
        activities={items as never}
        environmentId={ENVIRONMENT}
        anchorKey="anchor"
        expandedRows={{ anchor: true }}
        iconSubtleColor="#888"
        onToggleRow={() => {}}
      />,
    ),
  );
}

const stopButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Stop workflow Ship the release"]');
const notice = () => container.querySelector('[aria-live="polite"]');
const failure = (): AsyncResult.AsyncResult<void, Error> =>
  AsyncResult.failure(Cause.fail(new Error("offline")));

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** The next stop request stays open until the returned function settles it. */
function holdNextStop() {
  let settle: (result: AsyncResult.AsyncResult<void, Error>) => void = () => {};
  harness.stop.mockReturnValueOnce(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  return (result: AsyncResult.AsyncResult<void, Error>) => settle(result);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  harness.granted = new Set([ENVIRONMENT]);
  harness.liveAgents = [row()];
  harness.stop.mockReset();
  harness.stop.mockResolvedValue(AsyncResult.success(undefined));
  harness.announce.mockReset();
  harness.platform = "android";
});

afterEach(() => {
  act(() => root.unmount());
});

describe("ThreadSubagentGroup workflow Stop", () => {
  it("stops a running workflow T3 runs through the thread that owns it", async () => {
    show(turnItem("running"));

    act(() => stopButton()?.click());
    await flush();

    expect(harness.stop).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT,
      input: { threadId: PARENT, subagentId: "workflow-row" },
    });
    // A screen reader reaches the button on its own, not folded into the row's link.
    expect(stopButton()?.closest('[data-accessible="true"]')).toBeNull();
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "offers no Stop once the workflow is %s, whatever the turn item last said",
    (status) => {
      harness.liveAgents = [row({ status })];

      show(turnItem("running"));

      expect(stopButton()).toBeNull();
      expect(container.textContent).toContain(`Ship the release ${status}`);
    },
  );

  it("offers no Stop without the operate grant", () => {
    harness.granted = new Set();

    show(turnItem("running"));

    expect(stopButton()).toBeNull();
  });

  it("offers no Stop on an ordinary subagent or a workflow task with a thread of its own", () => {
    harness.liveAgents = [
      row({ id: "plain", workflow: undefined, origin: "provider_native" }),
      row({ id: "task", workflow: undefined, childThreadId: "task-thread" }),
    ];

    show(
      turnItem("running", { id: "item-plain", subagentId: "plain", origin: "provider_native" }),
      turnItem("running", { id: "item-task", subagentId: "task", childThreadId: "task-thread" }),
    );

    expect(container.querySelector('button[aria-label^="Stop workflow"]')).toBeNull();
  });

  it("offers no Stop before the live workflow row is known", () => {
    harness.liveAgents = undefined;

    show(turnItem("running"));

    expect(stopButton()).toBeNull();
  });

  it("reports a failed stop on the workflow it was for and retries that same target", async () => {
    harness.stop.mockResolvedValueOnce(failure());
    show(turnItem("running"));

    act(() => stopButton()?.click());
    await flush();

    expect(notice()?.textContent).toBe(STOP_FAILED);
    expect(stopButton()?.disabled).toBe(false);

    act(() => stopButton()?.click());
    await flush();

    expect(harness.stop.mock.calls).toEqual([
      [{ environmentId: ENVIRONMENT, input: { threadId: PARENT, subagentId: "workflow-row" } }],
      [{ environmentId: ENVIRONMENT, input: { threadId: PARENT, subagentId: "workflow-row" } }],
    ]);
    expect(container.textContent).not.toContain(STOP_FAILED);
  });

  it.each([
    ["ios", 1],
    ["android", 0],
  ] as const)(
    "announces a failed stop through the shared notice on %s (%d explicit announcements)",
    async (platform, announcements) => {
      harness.platform = platform;
      harness.stop.mockResolvedValueOnce(failure());
      show(turnItem("running"));

      act(() => stopButton()?.click());
      await flush();

      // TalkBack reads the live region; VoiceOver needs the explicit announcement.
      expect(notice()?.textContent).toBe(STOP_FAILED);
      expect(harness.announce).toHaveBeenCalledTimes(announcements);
      if (announcements > 0) expect(harness.announce).toHaveBeenCalledWith(STOP_FAILED);
    },
  );

  it("treats an interrupted stop as no stop attempt, not a failure", async () => {
    harness.stop.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    show(turnItem("running"));

    act(() => stopButton()?.click());
    await flush();

    expect(container.textContent).not.toContain(STOP_FAILED);
    expect(stopButton()?.disabled).toBe(false);
    expect(stopButton()?.textContent).toBe("Stop");
  });

  it("does not carry a stop in progress, or its result, to a different workflow", async () => {
    const settleFirst = holdNextStop();
    show(turnItem("running"));
    act(() => stopButton()?.click());

    harness.liveAgents = [row({ id: "workflow-b", title: "Other workflow" })];
    show(turnItem("running", { subagentId: "workflow-b", title: "Other workflow" }));
    const other = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Stop workflow Other workflow"]',
      );

    expect(other()?.disabled).toBe(false);
    expect(other()?.textContent).toBe("Stop");

    settleFirst(failure());
    await flush();

    expect(container.textContent).not.toContain(STOP_FAILED);
    act(() => other()?.click());
    await flush();
    expect(harness.stop).toHaveBeenLastCalledWith({
      environmentId: ENVIRONMENT,
      input: { threadId: PARENT, subagentId: "workflow-b" },
    });
  });
});

describe("ThreadSubagentGroup workflow Stop after a partial stop", () => {
  /** Stop is pressed while running; the server cancels the row, then a member's stop fails. */
  async function failPartialStop() {
    const settle = holdNextStop();
    harness.liveAgents = [row(), member()];
    show(turnItem("running"));
    act(() => stopButton()?.click());

    harness.liveAgents = [row({ status: "cancelled" }), member()];
    show(turnItem("running"));
    expect(stopButton()?.disabled).toBe(true);
    expect(stopButton()?.textContent).toContain("Stopping");

    settle(failure());
    await flush();
  }

  it("keeps the failure and an enabled retry while a member still runs, then retries the same target", async () => {
    await failPartialStop();

    expect(notice()?.textContent).toBe(STOP_FAILED);
    expect(stopButton()?.disabled).toBe(false);

    act(() => stopButton()?.click());
    await flush();

    expect(harness.stop).toHaveBeenCalledTimes(2);
    expect(harness.stop).toHaveBeenLastCalledWith({
      environmentId: ENVIRONMENT,
      input: { threadId: PARENT, subagentId: "workflow-row" },
    });
    // The retry went through; nothing more to offer until another stop is asked for.
    expect(stopButton()).toBeNull();
    expect(container.textContent).not.toContain(STOP_FAILED);
  });

  it("removes the retry once the members have settled", async () => {
    await failPartialStop();

    harness.liveAgents = [row({ status: "cancelled" }), member({ status: "cancelled" })];
    show(turnItem("running"));

    expect(stopButton()).toBeNull();
    expect(container.textContent).not.toContain(STOP_FAILED);
  });

  it("offers no Stop on a stopped workflow whose members still run, unless a stop was asked for here", () => {
    harness.liveAgents = [row({ status: "cancelled" }), member()];

    show(turnItem("running"));

    expect(container.textContent).toContain("Ship the release cancelled");
    expect(stopButton()).toBeNull();
    expect(container.textContent).not.toContain(STOP_FAILED);
  });

  it("does not count a member of another workflow, a provider-native task, or a task without a thread", async () => {
    harness.liveAgents = [row(), member({ id: "elsewhere", parentNodeId: "another-workflow" })];
    const settle = holdNextStop();
    show(turnItem("running"));
    act(() => stopButton()?.click());

    harness.liveAgents = [
      row({ status: "cancelled" }),
      member({ id: "elsewhere", parentNodeId: "another-workflow" }),
      member({ id: "native", origin: "provider_native" }),
      member({ id: "threadless", childThreadId: null }),
    ];
    show(turnItem("running"));
    settle(failure());
    await flush();

    // Nothing of this workflow is left running, so the failed request leaves no retry behind.
    expect(stopButton()).toBeNull();
    expect(container.textContent).not.toContain(STOP_FAILED);
  });
});

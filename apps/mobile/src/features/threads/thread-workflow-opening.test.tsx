import { resolveWorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type PressableProps = {
  children?: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { busy?: boolean; expanded?: boolean };
};

const harness = vi.hoisted(() => ({
  granted: new Set<string>(),
  stop: vi.fn(),
  dispatch: vi.fn(),
  announce: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AccessibilityInfo: { announceForAccessibility: harness.announce },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: PressableProps) => (
    <button
      type="button"
      role={props.accessibilityRole === "link" ? "link" : undefined}
      aria-label={props.accessibilityLabel}
      aria-busy={props.accessibilityState?.busy}
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
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string, params: unknown) => ({ type: "PUSH", name, params }) },
  useNavigation: () => ({ dispatch: harness.dispatch }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly environmentId: string }) =>
    harness.granted.has(atom.environmentId),
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    stopWorkflow: { permissionAtom: (environmentId: string) => ({ environmentId }) },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.stop }));
vi.mock("../../state/threads", () => ({ environmentThreadDetails: { threadAtom: () => ({}) } }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("./markdownCodeHighlightState", () => ({ useMarkdownCodeHighlight: () => null }));
vi.mock("./useOpenLinkedThread", () => ({
  useOpenLinkedThread: () => (target: { environmentId: string; threadId: string }) =>
    harness.dispatch({ type: "PUSH", name: "Thread", params: target }),
}));
vi.mock("./SubagentRow", () => ({
  SubagentRow: ({ subagent }: { subagent: { title: string } }) => <span>{subagent.title}</span>,
}));
vi.mock("./work-log-layout", () => ({
  WorkLogBlock: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { ThreadWorkflowOpening } from "./thread-workflow-opening";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const OTHER_ENVIRONMENT = EnvironmentId.make("environment-b");
const PARENT = ThreadId.make("parent");
const COORDINATOR_THREAD = ThreadId.make("coordinator-thread");
const MEMBER_THREAD = ThreadId.make("member-thread");
const SCRIPT = '// probe\nexport const meta = { name: "probe-wf" };\nconst GROUPS = [];';

type Status = OrchestrationV2Subagent["status"];

function openingFor(options: {
  readonly status: Status;
  readonly driver?: string;
  readonly parentLoaded?: boolean;
}) {
  const workflow: OrchestrationV2SubagentWorkflow = {
    name: "probe-wf",
    phases: [{ index: 1, title: "Alpha" }],
    agents: [
      {
        index: 1,
        label: "alpha:one",
        state: "running",
        phaseIndex: 1,
        phaseTitle: "Alpha",
        childThreadId: MEMBER_THREAD,
      },
    ],
  };
  const coordinator = {
    id: "coordinator-row",
    title: "Run the alpha workflow",
    prompt: SCRIPT,
    model: "claude-opus-5",
    status: options.status,
    result: null,
    startedAt: DateTime.makeUnsafe("2026-08-01T10:00:00.000Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-08-01T10:00:05.000Z"),
    childThreadId: COORDINATOR_THREAD,
    workflow,
    driver: ProviderDriverKind.make(options.driver ?? "claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude"),
  };
  const resolved = resolveWorkflowOpening({
    thread: {
      id: COORDINATOR_THREAD,
      lineage: {
        parentThreadId: PARENT,
        relationshipToParent: "subagent" as const,
        rootThreadId: PARENT,
      },
      creationSource: "provider" as const,
    },
    messages: [{ id: "message-1", role: "user", text: SCRIPT, workflowScript: true }],
    parentSubagents: options.parentLoaded === false ? null : [coordinator],
  });
  if (resolved === null) throw new Error("fixture is not a workflow opening");
  return { ...resolved, parentThreadId: PARENT };
}

let root: Root;
let container: HTMLElement;

function show(
  options: Parameters<typeof openingFor>[0],
  environmentId: EnvironmentId = ENVIRONMENT,
) {
  act(() =>
    root.render(
      <ThreadWorkflowOpening
        environmentId={environmentId}
        threadId={COORDINATOR_THREAD}
        opening={openingFor(options)}
      />,
    ),
  );
}

const stopButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Stop workflow probe-wf"]');

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
  harness.stop.mockReset();
  harness.stop.mockResolvedValue(AsyncResult.success(undefined));
  harness.dispatch.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
});

describe("ThreadWorkflowOpening status", () => {
  it.each([
    ["running", "Workflow running", true],
    ["completed", "Workflow finished", false],
    ["failed", "Workflow failed", false],
    ["cancelled", "Workflow stopped", false],
    ["interrupted", "Workflow stopped", false],
    ["pending", "Workflow", false],
  ] as const)("shows a %s workflow as %j, Stop offered: %s", (status, heading, stoppable) => {
    show({ status });

    expect(container.textContent).toContain(heading);
    expect(container.textContent).not.toContain("Workflow started");
    expect(stopButton() !== null).toBe(stoppable);
  });

  it("keeps the generic heading and offers no Stop before the parent's workflow row loads", () => {
    show({ status: "running", parentLoaded: false });

    expect(container.textContent).toContain("Workflow started");
    expect(stopButton()).toBeNull();
  });

  it("offers no Stop for a provider workflow T3 cannot stop", () => {
    show({ status: "running", driver: "codex" });

    expect(container.textContent).toContain("Workflow running");
    expect(stopButton()).toBeNull();
  });

  it("still opens a member's thread", () => {
    show({ status: "running" });

    act(() => container.querySelector<HTMLButtonElement>('button[role="link"]')?.click());

    expect(harness.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "PUSH",
      name: "Thread",
      params: { environmentId: "environment-a", threadId: "member-thread" },
    });
  });
});

describe("ThreadWorkflowOpening Stop", () => {
  it("hides Stop without the destination environment's operate grant", () => {
    harness.granted = new Set([OTHER_ENVIRONMENT]);

    show({ status: "running" });

    expect(container.textContent).toContain("Workflow running");
    expect(stopButton()).toBeNull();
  });

  it("stops the whole workflow through its parent thread, not the coordinator's own thread", async () => {
    show({ status: "running" });

    act(() => stopButton()?.click());
    await flush();

    expect(harness.stop).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT,
      input: { threadId: PARENT, subagentId: "coordinator-row" },
    });
  });

  it("shows Stopping while the request is open and counts a double tap once", async () => {
    let settle: (result: AsyncResult.AsyncResult<void, Error>) => void = () => {};
    harness.stop.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    show({ status: "running" });

    act(() => {
      stopButton()?.click();
      stopButton()?.click();
    });

    expect(harness.stop).toHaveBeenCalledOnce();
    expect(stopButton()?.disabled).toBe(true);
    expect(stopButton()?.textContent).toContain("Stopping");
    expect(stopButton()?.getAttribute("aria-busy")).toBe("true");

    settle(AsyncResult.success(undefined));
    await flush();

    expect(stopButton()?.disabled).toBe(false);
    expect(stopButton()?.textContent).toBe("Stop");
    expect(container.textContent).not.toContain("Could not stop");
  });

  it("reports a failed stop and lets the person retry", async () => {
    harness.stop.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
    show({ status: "running" });

    act(() => stopButton()?.click());
    await flush();

    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Could not stop the workflow. Try again.",
    );
    expect(stopButton()?.disabled).toBe(false);

    act(() => stopButton()?.click());
    await flush();

    expect(harness.stop.mock.calls).toEqual([
      [{ environmentId: ENVIRONMENT, input: { threadId: PARENT, subagentId: "coordinator-row" } }],
      [{ environmentId: ENVIRONMENT, input: { threadId: PARENT, subagentId: "coordinator-row" } }],
    ]);
    expect(container.textContent).not.toContain("Could not stop");
  });

  it("drops Stop once the workflow settles, even with the request still open", async () => {
    let settle: (result: AsyncResult.AsyncResult<void, Error>) => void = () => {};
    harness.stop.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    show({ status: "running" });
    act(() => stopButton()?.click());

    show({ status: "cancelled" });
    settle(AsyncResult.failure(Cause.fail(new Error("not running"))));
    await flush();

    expect(container.textContent).toContain("Workflow stopped");
    expect(stopButton()).toBeNull();
    expect(container.textContent).not.toContain("Could not stop");
  });
});

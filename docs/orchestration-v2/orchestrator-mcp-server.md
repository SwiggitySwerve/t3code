# Orchestrator MCP Server

## Purpose

T3 exposes V2 orchestration through its app-owned MCP endpoint. A provider
agent can use this endpoint to:

- create an app-owned sub-agent on any supported provider instance;
- wait for or poll the sub-agent's durable result;
- cancel an active delegated task; and
- create one or more ordinary top-level T3 threads;
- list a project's threads and incrementally read any thread;
- rename threads, regenerate titles, and link or unlink pull requests;
- send or steer follow-up messages; and
- wait for or interrupt ordinary thread runs.

These are T3 orchestration operations, not provider-native sub-agent APIs.
Delegated tasks always create a T3 child thread and run. The child receives
only the supplied task prompt, plus an optional role instruction supplied in
the same tool call. Parent conversation history is not copied into the child.

`ThreadManagementService` is the shared server application boundary for V2
WebSocket commands and MCP. It owns thread lookup, listing, send-mode
selection, durable send postconditions, wait polling, and interrupt selection;
`OrchestratorV2` remains the lower-level command/event processor. Transport
adapters only authenticate, resolve transport-specific inputs, and shape
responses.

## Transport And Authentication

The orchestration tools share the existing authenticated HTTP MCP endpoint:

```text
http://127.0.0.1:<server-port>/mcp
```

The provider-visible server key is `t3-code`. The endpoint registers both the
preview toolkit and the orchestration toolkit.

Before `ProviderSessionManager` opens a new V2 provider session, it asks
`McpSessionRegistry` for a credential scoped to:

- the T3 environment;
- the parent T3 thread;
- the concrete provider instance; and
- the provider session.

Workflow members (including judges) receive no `orchestration` capability, so they
cannot delegate or start workflows. Ordinary delegated children retain orchestration
access. A member also gets no preview or device capability. Worktree and pull-request access follow
their existing settings. Credentials
expire after a maximum lifetime, expire when idle, and are revoked when the
provider session is released. The raw token is not persisted in orchestration
state.

The MCP HTTP server resolves the bearer token and supplies the resulting
`McpInvocationScope` to tool handlers. Orchestration handlers additionally
check the `orchestration` capability before reading or mutating state.

**Member toolset.** A thread credential without `orchestration` belongs to a workflow member
(`hasMemberToolset` in `@t3tools/provider-core/server/mcpSession` owns the test). One filter at
`McpHttpServer` (`TOOLKIT_REQUIRED_CAPABILITY`, applied where toolkits and image tools register)
lists and calls only the tools of toolkits whose capability the member holds: the orchestrator,
thread, project, environment and attachment tools need `orchestration`, the preview tools need
`preview` and the device tools need `device`. A member sees the worktree, pull-request and html
tools; in the test registration that is 9 tools and 21,637 bytes of `tools/list` against 88 tools
and 283,106 bytes for a coordinator. A hidden tool is not listed and a call to it returns "Tool
'<name>' not found". Coordinators, ordinary threads and OAuth clients keep every tool, and
handlers still check their capability. The same test sets the instructions a member gets: Codex
members send `skills.include_instructions=false` on `thread/start` and `thread/resume` (Codex
reads it per thread and restores the catalog on a resume that omits it) and no
`t3_code_orchestration_*` context; Claude members get no orchestration or background-wait text and
keep every settings source (user and local settings hold permission rules, hooks and env that T3
also reads). Built-in Claude tools, skills and the system prompt preset are not restricted.

## Provider Injection

### Codex V2

Codex app-server receives the remote MCP server through command-line config
overrides:

```text
-c mcp_servers.t3-code.url=http://127.0.0.1:<port>/mcp
-c mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"
```

The provider-session token is placed in `T3_MCP_BEARER_TOKEN`. Both the
production Codex launcher and the injectable test launcher use the same
projection helper.

### Claude Agent SDK V2

Claude receives an HTTP MCP server in its query options:

```ts
{
  mcpServers: {
    "t3-code": {
      type: "http",
      url: "http://127.0.0.1:<port>/mcp",
      headers: {
        Authorization: "Bearer <provider-session-token>",
      },
    },
  },
  allowedTools: [
    // existing allowed tools
    "mcp__t3-code__*",
  ],
}
```

The adapter logs only whether MCP configuration exists; it does not log the
server headers or token.

### Cursor Agent SDK V2

Cursor receives the same authenticated HTTP MCP endpoint through the SDK's
`mcpServers` agent and send options. The adapter passes the authorization header
to the SDK but projects only redacted option metadata into protocol diagnostics.

### Grok ACP V2

Grok receives the authenticated HTTP MCP endpoint through the ACP
`session/new`, `session/load`, and `session/fork` `mcpServers` field. The shared
ACP adapter owns standard protocol behavior; the Grok flavor adds xAI extension
requests such as structured user questions.

ACP does not define native subagents or active steering. Grok therefore uses
orchestrator-owned child threads and implements steering through
cancel-and-restart. Its current driver also lacks `session/fork`, so app forks
use portable context transfer. These are orchestrator policies, not
provider-specific MCP tools.

### ACP Registry V2

The `acpRegistry` driver is the generic flavor of the same shared ACP adapter.
Each provider instance names an agent from the official ACP Registry. Settings
searches the registry through the connected server, then prepares a compatible
distribution before persisting the provider instance. Binary distributions use
a managed, versioned cache; declared checksums are verified when present.
Version-pinned `npx` packages install globally through `npm`; `uvx` packages use
`uv tool install`. ACP launches the resulting global command directly, so the
same command is available for terminal authentication. A local executable may
override the installed command without changing the registry-declared arguments
or environment.

Search, preparation, provider status, and session startup share one
server-scoped catalog service. This keeps platform selection and registry
validation identical across settings and runtime use. Catalog inspection never
starts an ACP process, probes models, or performs authentication. The managed
provider snapshot creates a disposable `session/new` through the normal provider
refresh lifecycle, using success as the authentication-readiness proof and
projecting advertised models into the snapshot. Terminal-only login remains a
manual operation on the connected server.

Capabilities such as session loading, session forking, models, modes, and MCP
transport are enabled only when the selected agent advertises them. Missing
features degrade through V2 policy: steering uses interrupt-and-restart,
forking uses portable context when native `session/fork` is unavailable, and
subagents use orchestrator-owned child threads. Registry agents do not receive
provider-specific extensions; those remain in flavors such as Grok.

### Pi V2

T3 keeps a provider-session HTTP bridge even when Pi supports native MCP.
`mcp.json` entries override native registrations, and native MCP's default
60-second request timeout can interrupt long-running T3 tools. The bridge owns
the injected endpoint and credential and forwards Pi's cancellation signal.

When a provider session credential exists, the adapter writes a T3-owned
extension into the server cache and spawns
`pi --mode rpc --extension <cache>/pi-t3-mcp-extension.ts` with:

```text
T3_MCP_URL=http://127.0.0.1:<port>/mcp
T3_MCP_BEARER_TOKEN=<provider-session-token>
```

The extension preserves public names under `mcp__t3-code__` for saved loadouts
and tool selectors. Modern Pi also receives hidden `mcp__t3_code__` aliases,
which reserve the normalized namespace against configured MCP servers without
adding declarations or search results. On Pi 0.99+,
`orchestrator_capabilities`, `delegate_task`, and `task_status` remain directly
available; optional tools are discovered through Pi's builtin `tool_search`.
On older Pi or without builtin search, all tools remain directly available.
The bridge calls the original MCP tool name over HTTP. Follow-up requests send
`mcp-protocol-version: 2025-06-18`; Effect's MCP transport returns 400
without it. The first turn of a session also receives the shared T3
orchestration instructions.

Pi keeps ownership of native extension discovery. T3 does not replace Pi's
`subagent` tool or reproduce Pi's package and project-trust loader. Durable
delegation goes through the namespaced T3 MCP `delegate_task` tool and the
shared orchestration child-thread lifecycle. When Pi's example `subagent`
extension is installed, the adapter observes its documented `details.results`
shape and projects task cards with no child thread id. Unknown result shapes
remain ordinary dynamic tool output.

### Provider Support

A provider instance can run child tasks when its live `ProviderInstance`
exposes a V2 `orchestrationAdapter` — the same registration the orchestrator
resolves when a `delegated_task.request` executes. That covers Codex, Claude
Agent SDK, Cursor Agent SDK, Grok, generic registry agents over ACP, OpenCode,
OpenCode 2, Pi, Antigravity, and any future driver that builds an adapter.
Capability discovery still reports other registered provider instances, but
marks them unavailable for orchestration when no adapter resolves. This keeps
provider selection model-visible without allowing a request that cannot run.

## Tool Surface

The orchestration toolkit includes the tools below.

### `orchestrator_capabilities`

Returns:

- the inherited provider instance and model;
- the parent runtime and interaction modes;
- registered provider instances and advertised models;
- whether each provider can run a child task; and
- feature flags for polling, cancellation, and batch thread creation.

Unavailable providers include model-visible constraints such as missing V2
adapter support, disabled state, missing executable, or missing authentication.

The model list is short on purpose: catalogs such as OpenCode can hold hundreds
of models, and every call lands in the agent's context. Each provider lists
custom, favorite, and the caller's own models, plus all current (non-legacy)
models for Codex, Claude, Muse, and Grok, or the first 8 current models in the
user's model order for other providers. `omittedModels` counts the rest, and the
`search` input finds them, legacy models included. `delegate_task` still accepts
any catalog model.

### `delegate_task`

Creates a T3-owned child thread and immediately dispatches the supplied task
prompt.

```ts
type DelegateTaskInput = {
  task: string;
  target?: {
    providerInstanceId?: string;
    driverKind?: string;
    model?: string;
  };
  title?: string;
  role?: "implementation" | "research" | "review" | "design" | "test" | "general";
  mode?: "async" | "wait";
  timeoutMs?: number;
  clientRequestId?: string;
  runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
  interactionMode?: "inherit" | "plan" | "default";
};
```

Provider, model, runtime mode, and interaction mode inherit from the parent
when omitted. A driver-only target inherits the parent's provider instance
when it can run child tasks, and otherwise selects an available instance of
that driver; an explicit `providerInstanceId` is honored exactly and fails
when unavailable. Selecting a different provider without a model uses that
provider's first advertised model.

A provider runs a runtime mode it does not offer as `approval-required`, so a
child would ask for approval on every command. `orchestrator_capabilities`
lists `runtimeModes` only for a provider that offers some of the modes, and
omits it for a provider that offers all of them. When the target lists
`runtimeModes`, an explicit `runtimeMode` outside that list is refused, and an
inherited mode steps down to the broadest mode the target offers.

Each independent delegated review round uses a new `delegate_task` call with the
original brief, prior findings, responses, and unresolved objections. Track each
round by its own `taskId` and use a distinct `clientRequestId` per round, stable
across retries of that round.
A follow-up that needs the same child's conversation goes through `t3_thread_send`
on its `childThreadId`. After the original task completes, that follow-up runs as a
fresh task in the child thread; it does not reopen the completed task or change its
published result.

Delegation requires an active parent run owned by the MCP credential's
provider session. The request becomes the V2 command
`delegated_task.request`.

`mode: "async"` returns the current durable state immediately.
`mode: "wait"` waits for the task result, including nested work and completion follow-ups, or until
the timeout expires. A wait timeout does not cancel the child; the result sets
`waitTimedOut: true`, and the caller can continue with `task_status`. A pending blocking
question also ends the wait with `hasPendingQuestion: true` and `waitTimedOut: false`.
If `hasPendingQuestion`, pass `threadId=childThreadId` to `t3_pending_request_list`,
`t3_pending_request_read` (with `requestId`) and `t3_pending_request_respond`, or ask
the user; the task's completion still wakes this thread. A pending live approval for the
task's own unfinished work also ends the wait. Its identity appears in `pendingApproval`;
it grants no approval authority. Read the fresh full request in the child thread before
responding, since the durable record can outlive its provider callback. Async questions
do not end the wait.

```ts
type DelegateTaskResult = {
  taskId: string;
  childThreadId: string;
  childRunId: string | null;
  childNodeId: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  workState: "working" | "waiting_for_children" | "result_available";
  hasPendingChildRuns: boolean;
  providerInstanceId: string;
  model: string | null;
  summary: string | null;
  resultContextTransferId: string | null;
  latestTerminalRunId: string | null;
  latestTerminalStatus: "completed" | "failed" | "cancelled" | "interrupted" | null;
  latestTerminalSummary: string | null;
  latestTerminalResultContextTransferId: string | null;
  hasPendingQuestion: boolean;
  pendingApproval: {
    requestId: string;
    kind: "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission";
    runId: string;
  } | null;
  waitTimedOut: boolean;
};
```

### `delegate_tasks`

Starts up to 100 delegated tasks in one call. Each entry takes the same fields as
`delegate_task` except `mode` and `timeoutMs`: batched tasks always run async.
Every entry is resolved and checked before any starts, so an invalid entry starts
nothing and the error names its index. An entry's retry key is its own
`clientRequestId`, or the batch `clientRequestId` plus its position, and maps to
the same command id `delegate_task` would use. Retrying a batch therefore starts
only the entries that did not start. The result lists each `taskId`,
`childThreadId`, status, provider and model in request order.

A coordinator agent that fans out N tasks one `delegate_task` call at a time
spends one model step per task and, in practice, does not start them all in one
turn. One `delegate_tasks` call removes both costs.

### Structured results

`delegate_task` and `delegate_tasks` take an optional `resultSchema`, a JSON
Schema. The child's prompt asks it to end its final message with a fenced json
block matching the schema, between `<t3-result-schema>` markers that the server
reads back. `task_status` and `task_wait` then return `structuredResult` when
the last json block parses and matches (checked with ajv), or
`structuredResultError` naming what is missing. The prompt is the only place
the schema is stored, so a task's schema cannot drift from what its child saw.

### Running limit

`maxRunningDelegatedTasks` in server settings (default 16) caps delegated
children that run at once across the environment. A child past the limit is
created as a `preparing` run with `admission: "waiting"` and a "Waiting for a
free agent slot" item, and reports `queued`. When an admitted child's run ends,
and at server start, the oldest waiting runs are released through
`prepared-run.release`. New children queue behind waiting ones, so order is
first come, first served. Worktree children already wait for their checkout and
are admitted when created: they count toward the limit but are not held by it, so
a fan-out of many worktree children can run past it (a known gap). Concurrent delegations from different parents can
briefly exceed the limit by the number of racing commands.

### `task_wait`

Waits for up to 100 delegated tasks of the calling thread. Mode `all` (the
default) returns when every task is ready, `any` when at least one is. A task is
ready when it is terminal or waits on a question or approval. Ready tasks come
back with their summaries in request order and the rest as pending; a timeout
returns `timedOut: true` and cancels nothing. Reading a finished task
acknowledges its delivery like `task_status`, so the parent is not also woken
for it. The wait follows the parent's `subagent.updated` events for status and
each child's `runtime-request.updated` events for questions and approvals.

### `task_status`

Reads a delegated task from the parent thread's durable projection. A task ID
from another parent thread is rejected. `childRunId` identifies the original
run. `workState` distinguishes active work, a finished turn waiting for children,
and an available result. The task remains nonterminal until its known work
finishes. Its published `summary` and result transfer then remain stable across
later follow-ups. `hasPendingChildRuns` reports later queued or executing turns;
`latestTerminal*` exposes later executed, non-monitor results without replacing
the published task result.

### `task_cancel`

Stops the child thread with the internal `thread.stop` command, then stops every
task the child delegated, and disposes automatic parent delivery. Like a user Stop,
`thread.stop` interrupts the running turn, holds queued turns, and ends pull request
watches. A nonterminal task with no interruptible run is rejected. A terminal task
returns its existing status, and its child thread still stops, including later
runs and watch wakes. Published task results remain available. It accepts an
optional cancellation reason.

### Workflows: `workflow_start`, `workflow_status`, `workflow_stop`

`workflow_start` runs a script that starts and combines delegated tasks, so one
call covers fan-out, phases and follow-up steps that would otherwise take one
model step each. It returns a `workflowId` at once; the calling thread is woken
once, when the script ends. Any provider can call it.

Scripts use the Claude Code Workflow format: an optional
`export const meta = { name, description, phases: [{ title }] }`, then a body that
may `await` and `return`. The script reads `args` (the JSON value passed to
`workflow_start`) and can call:

- `agent(prompt, options)`: starts one delegated task and resolves to its summary,
  or to the parsed `structuredResult` when `options.schema` is set. Options are
  `label`, `phase`, `model` or `target` (provider instance, model, options),
  `isolation`, `role` and `schema`. A failed or cancelled agent resolves to
  `null`, and the failure is recorded on the agent.
- `parallel(functions)`: runs every function and resolves to their results in
  order. `pipeline(items, ...stages)` passes each item through the stages in turn,
  with all items running at once; a stage gets `(previous, item, index)`, and an
  item stops at the first stage that returns `null`. Both accept at most 4,096
  items; a step that throws resolves to `null`.
- `budget.total`, `budget.spent` and `budget.remaining()`: the token budget
  passed as `budgetTokens`, or `null` and `Infinity` without one.
- `phase(title)` and `log(...values)`: progress shown in `workflow_status` and the
  workflow row.

Every `agent()` call is an ordinary delegated task under the workflow, so model
options, worktree isolation, mode ceilings, the running limit and structured
results apply unchanged. Its retry key is a hash of its phase, label, prompt,
schema, target and isolation plus how many identical calls came before it, so a
re-run maps each call back to the same task. A workflow may start at most 1,000
agents.

The script runs in a QuickJS sandbox (`quickjs-emscripten`), one module per run,
with no filesystem, network, process or timer access. `Date.now()`,
`Math.random()` and `new Date()` throw, because a resumed script must make the
same calls in the same order. Memory is capped at 256 MB and each synchronous
slice at 10 seconds. A script that fails to compile is rejected before anything
starts.

The workflow is an app-owned subagent row on the calling thread whose `workflow`
field holds its phases and agents; the existing workflow view renders it.
Member tasks hang under that row, and their own completion deliveries are
disposed, so only `workflow.complete` delivers to the caller. `workflow_status`
returns the status, phases, each agent's status, model and summary, the latest
log line, and the script's return value as JSON or why it failed. For a workflow
started from a graph it also returns `nodes`, the stored outcome of each node
(see Graphs, below).

Each agent also reports cumulative `usage`, `outcomeCategory`, and `timings`. Usage
is recomputed from persisted provider-turn totals across every child run and retry;
workflow totals include every member, including independent judges and their retries.
`inputTokens` includes cached reads (`cachedInputTokens`) and cache writes
(`cacheCreationTokens`). `uncachedInputTokens` subtracts both from input; an omitted
cache-write count contributes zero to that subtraction. Output includes reasoning.
`totalTokens` and `tokensUsed` count input plus output, rather than context occupancy.

Usage `status` is `complete`, `partial` (known counts are lower bounds), or
`unavailable`. Unknown counts are null, never a measured zero. Cache breakdowns
may be null even when input/output totals are complete. Cursor, Grok and Antigravity
report no totals; interrupted or cancelled turns may also have none. Totals cover
the provider's reported main-agent scope; unreported provider-native subagents are
not measured. Older workflow rows without attempt IDs can attribute only their
latest attempt to an agent (reported as partial when retries are known); the workflow
total still includes all member tasks.

Terminal outcome categories are `never_started`, `timed_out`, `cancelled`,
`provider_error`, `check_failed`, and `completed`; active agents report null.
Categories record runner facts, including a deadline stop or an unsuccessful check.

Timing values are epoch milliseconds, or null when unrecorded: `createdAt`,
`runStartedAt`, `providerTurnStartedAt`, `providerTurnEndedAt`, `completedAt`
(after checkpoint capture), and `runnerSettledAt`. For retries they span the first
creation/start through the last end/completion, including gaps. They do not sum
parallel durations or separate individual model responses inside a provider turn.
Checkpoint behavior is unchanged.

`workflow_stop`, and `task_cancel` on a `workflowId`, stop the script, stop every
running member as `task_cancel` would, and settle the workflow as cancelled.
Stopping the calling thread does the same.

#### Checks and file scopes

These follow the `omx graph` execution graph's protected verifiers
(`~/.agents/graph`), adapted to T3 agents.

- `verify` checks an agent's result before `agent()` returns it:
  - `{ type: "process", argv, cwd?, timeoutMs?, maxOutputBytes?, successExitCodes? }` runs
    `argv` in the agent's workspace (its worktree, the caller's worktree, or the project
    root) without a shell, and passes on an allowed exit code (default `[0]`).
    `{{result}}` in an argument becomes the path of a file holding the agent's result.
    Limits: 256 arguments, 64 KiB of arguments, 15 minutes (default 2), 1 MiB of output
    (default 64 KiB). A `.cmd` or `.bat` launcher is refused, because it needs a shell.
    Running a command needs the calling thread in full-access mode; otherwise the agent is
    refused before it starts.
  - `{ type: "structured", requiredPointers?, equals? }` reads JSON pointers from the
    agent's structured result, so it needs `schema`. With `outputId`, it reads that
    declared output file's JSON instead and needs no `schema`; without pointers it only
    requires the file to hold JSON.
  - `{ type: "judgment", rubric, target? }` starts a separate agent, labelled
    `check <label>`, that grades the result against the criteria and answers
    `{ outcome: "passed" | "failed", reasons }`. A judge can be wrong; its reasons are kept.
    The judge grades the returned result and works in the caller's checkout, so it does not
    see files a worktree agent changed; check those with a process check instead.
    A failed check starts the agent again with what the check saw appended to its task,
    within the same three attempts. A check that cannot run (timeout, too much output, a
    missing executable, no verdict) fails the agent without retrying. When the agent was
    given a `schema`, a result that does not match it fails a `structured` check first,
    whatever else is checked. `workflow_status`
    reports each agent's latest `verification` (type, outcome, attempts, detail), and an
    agent that failed its check reports `failed`. Process checks run again when a workflow
    resumes after a restart.
- `scopes: { read?, write? }` lists workspace-relative paths. They are added to the
  agent's task as instructions; they are not enforced on the file system. Two agents in
  the same checkout whose write scopes overlap (one path equals or contains the other)
  never run at once: the later one waits. Agents with `isolation: "worktree"` do not wait.
- `inputs` and `outputs` declare the files an agent reads and must write, as
  `[{ id, path, maxBytes?, sha256? }]` with workspace-relative paths (at most 32 each,
  `maxBytes` default 256 KiB, at most 16 MiB). They need the shared checkout, so
  `isolation: "worktree"` refuses them. Inputs are listed in the agent's task in one
  `<t3-handoff v="1">` block that says its content is data, not instructions: an
  `<input>` per file with its `id`, `path`, `maxBytes` and, when pinned, `sha256`.
  An entry may also carry `from`, a node id. In a graph, a `task_output` input carries
  `from` and the body of its `<input>` is the summary the producing node stored,
  cut at 2,048 bytes and escaped (`&` and `<`) so it cannot close the block; nothing
  else of the producing agent reaches it. Outputs follow the block, listed under
  "Output files you must write:". A graph node, and any agent that declares outputs,
  is also asked to end with a summary of at most about 1,500 characters (with a
  `schema`, to keep the text before the JSON block short), because that summary is
  what the next agent and the coordinator read.
  - Before each attempt, every input must exist within `maxBytes`, and an input with
    `sha256` must still have those bytes; otherwise the agent fails without starting.
  - After the turn, every output must exist within `maxBytes`. A missing or oversized
    output fails an `outputs` check, which retries like any failed check; `verify`
    runs only once the outputs pass, and a process check may name a declared file as
    `{{input:<id>}}` or `{{output:<id>}}` (an absolute path in the checkout).
  - Outputs count as write scopes, so two agents never write the same output at once.
  - `agent()` then returns `{ result, outputs: { <id>: { path, sha256, sizeBytes } } }`,
    so a later agent can pin what an earlier one wrote.
- `report: true` makes `agent()` always resolve to
  `{ ok, result, outputs, attempts, verification, reason }`, failed or not, instead of
  `null` on failure, so a script can record why an agent failed. A spent budget still
  throws.

#### Ultracode

The `ultracode` server setting (also a project override; Settings, General) asks agents
to orchestrate substantive work as a workflow. `keyword`, the default, opts in a turn
whose message contains the word ultracode; `always` opts in every user or agent turn;
`off` never does. System turns, such as completion wakes, are never opted in. An opted-in
turn reaches the provider with a `<t3-ultracode>` note asking for `workflow_start`; the
stored message is unchanged. Claude Code has its own ultracode, which the keyword starts,
so a Claude turn only gets the word ultracode added when `always` opts it in.
`@t3tools/provider-core/server/ultracode` owns this rule. Run execution applies it through
`@t3tools/provider-core/server/workflowTrigger`, where a person's message that asks for a
workflow (the `workflowTriggers` setting) gets a plan-first `<t3-workflow>` note naming
`graph_review` instead of the ultracode note, on every driver. Only a person's message on a
thread that is not a delegated task can ask; wakes, steers, restart continuations and
server-made replies cannot. The detector reads the stored message, not the provider text.

A request for a workflow arms an approval gate for that thread
(`apps/server/src/orchestration-v2/WorkflowApprovalGate.ts`, which owns its state and asks
the same detector). While it is armed the server refuses `workflow_start`, and refuses
`graph_start` for any digest the user has not approved. The agent plans with `graph_review`
and ends its turn; the user approves or dismisses that review in the client
(`orchestration.approveWorkflowReview`, `orchestration.dismissWorkflowReview`, which need
the operate grant and are not MCP tools).

The client decides from the review's **approval record**, never from the `graph_review` tool
output. When `graph_review` finishes, the server writes a `workflow_review` turn item (command
`workflow.review.record`, built by `apps/server/src/mcp/workflowReviewRecord.ts`) next to the
tool call: the review id and digest the gate issued, whether it is ready and needs approval,
blockers, and a compact plan (each task's name, step, dependencies, worker and judge target,
and check type) with the cost advice. It is bounded: at most 120 tasks, 24 dependencies per
task and 20 blockers, each text clipped at 400 characters, and the item says how many it left
out, so a review whose full result is too large to store still carries its decision data. If a
review the user must approve cannot be recorded, `graph_review` fails with an error that tells
the agent to call it again; any other review loses only its card. A thread from before the
record existed has the tool call alone, which shows as an ordinary tool row with no approval
controls.

A request is armed until it is settled. Armed refuses; settled does not.

- **Approve** records the digest and sends the agent a message, from the server on the
  user's behalf, that carries it. The request stays armed: only that digest may start, and
  any other graph or script is still refused.
- **A successful start of the approved digest** settles the request. Later starts on the
  thread, including scripts and other graphs, follow the ordinary rules for a thread nobody
  asked a workflow on. A start that fails or is interrupted settles nothing.
- **Dismiss** settles the request at once and tells the agent not to start a workflow for it.
  Starts are not refused afterwards; the instruction is all that stops the agent. A repeated
  Dismiss succeeds and sends nothing new. Approve after Dismiss is refused with
  `no-pending-request`, which the client shows as an expired review.
- **The user's next message** that asks for no workflow lifts the gate, and a new request
  replaces it with a fresh one.

One request and one graph are one run. Two identities are kept apart.

- **Launch identity: thread, request and digest.** The gate derives a start key,
  `approval:<thread>:<request message>:<digest>`, and uses it as the `clientRequestId` of the
  `workflow.start` command, replacing whatever key the agent sent. If the start commits its
  workflow and then fails or is interrupted, a retry of the same digest, with any key or none,
  finds that workflow instead of starting a second one. The key does not depend on the
  decision, so it is the same after a restart: a fresh review and approval of the same request
  and digest returns the workflow the first approval began, whether it is still running or
  has finished. It does not start another. To run the same graph again, the person sends a new
  message that asks for a workflow, which is a new request with a new key. A different digest
  is a separate review and a separate start. The command id is made in an `approval`
  namespace rather than from the agent's provider session, so a retry from a new provider
  session finds the same workflow. A stable key is not an approval: after a restart the
  approval is gone, and no start runs until the person approves a fresh review. A start
  refused before it reaches `workflow.start`, for example because the reviewed model is no
  longer served, leaves the approval in place; the same digest can start once the target is
  served again, and T3 never moves to another entry.
- **Delivery identity: thread, request and decision.** The messages the gate sends are named
  by the thread, the request and a decision id the gate makes in this process. Repeated and
  concurrent clicks share the decision id, so they share one message. A review made and
  approved after a restart gets a new decision id, so the agent is told again and its message
  is not mistaken for the earlier one, which a command receipt would otherwise answer. Every
  call returns the same ids, so a call that repeats after a failed send reaches the receipt or
  sends the missing message.

State is in memory only. After a restart (or an upgrade, which restarts) the gate is armed
again from the thread's latest started person-typed message, whether its request was pending,
dismissed or already started, so every review and approval must be made again, even when the
agent sends back the expanded graph with the old digest. "Started" means the message began a
run: a message still waiting in the queue, and steers, do not count. The trigger settings in
force now decide whether the message asks for a workflow. Delegation (`delegate_task`,
`delegate_tasks`) is not gated.

Two limits of an approved start are accepted. The orchestrator stores a `workflow.start` that it
rejected, under the start key. Retrying that approved digest repeats the rejection, even after
a restart, until the person sends a new message that asks for a workflow (a new request, so a
new key). And when a committed workflow's agents have changed an input file of the reviewed
graph, a retry fails the input check instead of returning the workflow; that failure is
closed, and no second run starts.

#### In the app

The calling thread's timeline shows a T3-run workflow where it started: its state
(running, finished, failed or stopped), name and description, agent counts, the
script's latest log line (or, once it ends, its result), each phase with its agents
and their own provider icons, and the script, folded when long. While it runs, a
Stop button stops the whole workflow. The thread's Lineage panel shows the workflow
as one row whose phases expand to its agents, with the same Stop. Agents open their
own threads. The row stores the script with a settings line for its args and budget;
`@t3tools/shared/storedWorkflowScript` owns that format for the server and clients.

#### Durability and limits

- **Restart.** A server stop leaves running workflow rows open. Once startup
  recovery has settled the runs the stop cancelled, the runner starts each
  script again from the stored script, args and budget. Retry keys map every
  `agent()` call back to its task, so finished agents return their stored
  results at once and running ones are waited on again; no agent starts twice.
  Recovery marks the runs it cancels with `cancelledByServerRestart`.
- **Retries.** An agent runs at most three times in all. It runs again when it
  failed, when a server restart cancelled it, or when it stalled. An agent a user
  stopped is not retried; the script sees `null`.
- **Stalls.** Every 30 seconds the runner checks each waited-on agent's thread.
  If its last update has not changed for `stallTimeoutMs` (default 20 minutes,
  at least 1 minute), the runner stops the agent and starts it again.
- **Attempt deadlines.** `attemptTimeoutMs` (1 minute to 6 hours) bounds each
  attempt, measured from the attempt's run start, so it holds across a restart.
  The same sweep stops an attempt past its deadline; that counts as a failed
  attempt and retries with a note asking the agent to finish within the budget.
  It is separate from `stallTimeoutMs`, which measures inactivity.
- **Approved starts.** A start rejected inside `workflow.start` is remembered under the
  approval's start key and repeats its rejection on every retry, across restarts, until the
  person sends a new message that asks for a workflow. A retry after the committed workflow
  changed a reviewed input file fails closed rather than returning the workflow.
- **Budget.** `budgetTokens` counts cumulative input plus output for finished
  attempts, including cached reads and writes, retries and judges. It does not count the
  coordinator's own tokens, which were 20-26% of the total in the C1 baseline and 58-63% after
  the C3 member trim (C4, Codex members). `graph_review`
  suggests a value (`advisory.suggestedBudgetTokens`). It is an estimate
  rather than a bill. Once it is spent, `agent()` throws for any agent that has not
  already started; agents already running finish. `workflow_status` reports
  `tokensUsed`, `usage`, and `budgetTokens`. The script's `budget.spent` and remaining
  allowance use known totals only; missing usage cannot enforce the cap. Completed
  attempts are counted again from persisted records when the script resumes.
- **Caps.** 1,000 agents per workflow and 4,096 items per `parallel` or
  `pipeline` call. The environment-wide running limit applies to every agent.
- **Bounded text.** `apps/server/src/mcp/workflowHandoff.ts` owns the byte caps and the
  marker `...truncated (<shown> of <total> bytes)`, which counts toward the cap and
  may end with where the whole is: an agent's stored result 2,048 bytes (with
  `full output at task_status taskId=<id>`), the inline summary of a declared input
  2,048 after escaping (a summary that escapes to more is cut to a shorter start, never
  to nothing), a check's recorded detail 2,048, the check detail an agent sees when it
  retries 4,000, a graph's result 4,096, a failed workflow's 4,096, and a script's
  return value 16,000 (`return a file path for large results`). A judgment checker is shown
  at most 24,000 bytes of the answer it judges, escaped, inside one `<t3-result>` block. A
  longer answer is also written, up to 256 KiB, to a new file `checker-<id>.txt` in the
  server's own `workflow-results` folder under its state directory, never in the user's
  checkout, because a checker is a sibling of the agent it judges and cannot read that
  agent's `task_status`. The cut marker names the file by absolute path. Each check has its own
  file, and the check removes only that file when it ends; the folder is shared and is never
  removed. A file left by a server that stopped mid-check is cleared by the next write once it is a
  day old, and only files with that name are ever cleared; a file whose check is still running in
  this server process is never cleared, however long that check waits in a queue. Codex members can read the path under
  every runtime mode (their sandbox limits writes, not reads); Claude members get the folder as an
  added directory. If the file cannot be written, the checker sees the cut marker without a
  pointer.
- **Worktrees.** `agent(prompt, { isolation: "worktree" })` gives that agent its
  own checkout of the calling thread's commit, like `delegate_task`.

### Graphs: `graph_review`, `graph_start`

A graph declares work as nodes with dependencies, files and checks instead of a
script. It follows the `omx graph` execution graph (`~/.agents/graph`): review
binds the inputs, the reviewed digest gates the start, and a graph completes only
when every node passed its checks.

```json
{
  "schemaVersion": 1,
  "name": "serial",
  "nodes": {
    "inventory": {
      "subject": "Inventory fixed source data",
      "description": "Read the input and publish its canonical JSON.",
      "dependsOn": [],
      "scopes": { "read": ["fixtures"], "write": ["artifacts"] },
      "inputs": [
        { "id": "source", "kind": "workspace_snapshot", "path": "fixtures/input/inventory.json" }
      ],
      "outputs": [{ "id": "inventory", "path": "artifacts/inventory.json", "maxBytes": 65536 }],
      "verify": {
        "type": "process",
        "argv": ["node", "verify.mjs", "{{input:source}}", "{{output:inventory}}"]
      },
      "attemptBudget": "short"
    },
    "summary": {
      "subject": "Summarize the published inventory",
      "description": "Read the published inventory and publish its summary.",
      "dependsOn": ["inventory"],
      "inputs": [
        { "id": "inventory", "kind": "task_output", "nodeId": "inventory", "outputId": "inventory" }
      ],
      "outputs": [{ "id": "summary", "path": "artifacts/summary.json" }],
      "verify": { "type": "structured", "outputId": "summary", "requiredPointers": ["/item_count"] }
    }
  }
}
```

- **Nodes.** `subject` is the agent's label and `description` its task. Optional:
  `phase`, `target`, `role`, `schema`, `scopes`, `inputs`, `outputs`, `verify` (as
  for workflow agents), `stallTimeoutMs`, and `attemptBudget`: `short`, `standard`
  (default) or `long`, 30 minutes, 2 hours or 6 hours per attempt. `long` needs
  `longBudgetApproved: true`.
- **Inputs.** A `workspace_snapshot` names a file in the caller's checkout. A
  `task_output` names an output another node declares; that node must be in
  `dependsOn`.
- **`graph_review({ graph })`** validates the graph and reports its problems as
  blockers: bad or duplicate ids, unknown or cyclic dependencies, unsafe paths, a
  `task_output` naming an undeclared output or a node outside `dependsOn`, two
  nodes declaring one output path, `long` without approval, a structured `outputId`
  the node does not declare, a missing or oversized input, and a graph over capacity.
  Review first refuses a graph with more than 1,000 nodes, or one whose worst case
  exceeds the 1,000-agent workflow cap (see **Caps**): one agent per node, plus up to
  three judges for each node with a `judgment` check. A capacity refusal can omit the
  remaining per-node problems; reduce the graph and review again. It hashes every
  `workspace_snapshot` input and returns the run order as `layers`, `writeConflicts`
  between nodes with no path between them (the runner runs those one at a time), the
  inputs it found, `ready`, and a `digest` over the normalized graph and the input
  hashes. It starts nothing; Claude's read-only tool list includes it. A graph that parses also
  gets an `advisory` with `fanOut` (`consider_single` for a lone node, a chain, or two nodes
  with no check), up to three short `reasons`, the node count, widest wave, depth and verifier
  count, `estimatedModelCalls` and `estimatedTokens` (low and high, with the coordinator's part
  and a `basis`), `suggestedBudgetTokens` (1.4 times the agents' high estimate, without the
  coordinator) and `overshootBoundTokens` (the widest wave times three calls at each node's
  high figure). Calls are 2-3 per agent and 3-4 for the coordinator. The token figures per call
  depend on the provider driver that runs the agent, which `graph_review` resolves for each
  node, each judge and the coordinator. Codex-driver agents use the C4 re-bench of 2026-10-26
  (Sonnet 5.5 through cliproxy): 17k-26k tokens per member call and 96k-106k per coordinator
  call. Every other driver, Claude included, was not measured and keeps the earlier estimate of
  37k-96k per call until it is; a Claude coordinator is therefore also unmeasured. An agent whose
  driver is unknown is priced as unmeasured, so a graph with Codex and Claude members is priced
  agent by agent. The `basis` says which figures were used. Tasks that read more than the
  benchmark's one or two small files will exceed the member high figure; the headroom and the
  thresholds are opinion. The advisory counts one judge agent per judgment check. It is not in the
  digest and never changes `ready`, `blockers` or `approvalRequired`, and it never blocks a start,
  including when the user asked for a workflow. It also returns
  a `reviewId` the server made for this review, and `approvalRequired`, true while a
  user's request for a workflow waits for approval (above). The server keeps the review
  in memory so the user's decision can be bound to it; the client decides by `reviewId`
  and `digest`, never by what the agent echoed. The server notes which request is armed
  before the review reads anything. If the request was replaced, lifted or settled while the
  review ran, the call fails as stale and records nothing, so a slow review never becomes
  approvable under a newer request.
- **`graph_start({ graph, acceptedDigest, budgetTokens?, title?, clientRequestId? })`**
  reviews again, which revalidates the capacity bound, and refuses blockers, a
  digest mismatch, or an input file that changed since the review (naming the files,
  for reviews this server process made). Reviews are kept in memory, so after a
  restart a mismatched digest is refused as "Review not found"; run `graph_review` again. A digest that still
  matches starts without the record, unless the user's request for a workflow waits: then
  the approval gate refuses first, before the graph is rebuilt, and only a digest the
  user approved starts. It starts under the key of the thread, request and digest, which replaces
  the `clientRequestId` you send, so a repeat of that start, in this process or after a
  restart, returns the same workflow. It then
  runs the graph as a workflow, so `workflow_status`,
  `workflow_stop`, resume after a restart, the budget, the app's display and the one
  completion wake work as for a script.
- **Running.** The stored script is one fixed driver with the graph as its args.
  A node starts once its own predecessors passed. Its snapshot inputs are pinned to
  the reviewed hashes, and its `task_output` inputs to the path and hash its
  producer published, so a node never reads bytes other than those reviewed or
  produced. Each node runs with `report: true` and its attempt deadline. A node
  whose predecessor did not pass is skipped, naming that predecessor.
- **Result.** If every node passed the workflow completes with `{ ok: true, nodes,
  omitted }`. Otherwise the script throws and the workflow fails with
  `The workflow failed: Graph failed: ` and a summary: how many nodes failed and were
  skipped, and up to three reasons. Only a workflow started from a graph gets the
  compact record (graphs started before this change keep their full record; see
  Provenance); a script that returns graph-shaped data keeps its own result. The
  record holds, per node, `status` (`passed`, `failed` or `skipped`), `attempts`, a
  `reason` (at most 240 bytes) when it did not pass, and `outputs` (id to `path` and
  `sizeBytes`), as many of these as fit in 4,096 bytes: every status first, then
  reasons, then output paths. A graph too large for one status each (between 70 and 90 nodes, by id length)
  becomes `{ ok, counts, reasons, omitted }`. Input digests, output sha256 and check
  details are never in it. `omitted` always names where they are:
  `workflow_status` with the `workflowId`, field `nodes`. A failed graph run's text, when
  it is cut at 4,096 bytes, ends with a pointer to the same place.
- **Provenance.** As each node ends, its outcome is stored on the workflow row with its
  `status`, `attempts` and `reason`, `inputs` (input id to the sha256 of the bytes the
  node was given) and `outputs` (output id to `path`, `sha256` and `sizeBytes`). Nothing
  but hashes, paths and sizes is stored. This holds for failed graphs too, where only
  the summary above is the result, and `workflow_status` returns it as `nodes` for any
  size of graph. A check's `verification` is not in `nodes`; it stays on
  `workflow_status.agents[]` (detail up to 2,048 bytes). A graph started before this
  change has no `inputs` or `outputs` on its nodes, so when it finishes it keeps its full
  record, cut at 16,000 bytes like a script result, instead of the compact one.
- **Mapping to omx.** Field names are the omx `ProtectedExecutionContractV1` names in
  camelCase: `depends_on` → `dependsOn`, `node_id` → `nodeId`, `output_id` →
  `outputId`, `max_bytes` → `maxBytes`, `attempt_policy.budget` → `attemptBudget`,
  a `structured_artifact` verifier → `verify: { type: "structured", outputId }`, and
  an `independent_judgment` verifier → a `judgment` check (or a `process` check
  when it is a command). Not carried over: content-addressed output snapshots (so
  producers cannot use worktrees), publication supersession, staffing and worker
  allocation.
- **Owners.** `apps/server/src/mcp/workflowGraph.ts` owns graph parsing, review and
  the driver script; `workflowChecks.ts` owns paths, files and checks;
  `workflowRunner.ts` owns running agents.

### `create_threads`

Creates between one and twenty ordinary top-level T3 threads:

```ts
type CreateThreadsInput = {
  threads: Array<{
    prompt?: string;
    title?: string;
    target?: {
      providerInstanceId?: string;
      driverKind?: string;
      model?: string;
    };
    runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
    interactionMode?: "inherit" | "plan" | "default";
  }>;
  clientRequestId?: string;
};
```

Each entry independently resolves provider, model, and modes. The new threads
inherit the parent's project, branch, and worktree path, but they have no
sub-agent lineage. Entries with a prompt immediately dispatch a run; entries
without a prompt remain idle.

### `t3_thread_launch`

Launches one ordinary top-level thread through the app's launch service. Use an
explicit `workspaceStrategy` to create a new worktree (`worktree` with `baseRef`),
attach an existing checkout (`existing_worktree` with `worktreePath`), or use the
project root (`root`, also the default). The thread is bound to that workspace
before the agent starts. Creating a worktree in the task prompt does not update
this binding.

Pass the task in `message`. Project, model, and modes inherit when omitted;
workspace does not. `scratch: true` launches without a project, in a folder of
its own under the environment's Scratch project. For stacked PRs, use the parent branch as `baseRef` with
`startFromOrigin: false`. The new thread may not run with broader runtime or
interaction modes than the caller. Launch has no retry key, so inspect existing threads after a failed or lost response before
launching again. `create_threads` remains the batch option for a shared checkout.

### `t3_thread_list`

Lists durable thread shells in one project, newest first: `projectId` when
given, else the calling thread's project. Callers can filter by title, run
status, and whether app-owned sub-agent threads are included. Results are
bounded and offset-paginated. Deleted threads are never listed.

### `t3_thread_read`

Reads the durable state, recent runs, and visible timeline of any thread in
the environment by thread ID. A deleted thread returns `thread_not_found`. The
default `messages` view returns user messages, assistant
messages, and proposed plans. The `activity` view also returns summarized tool,
reasoning, checkpoint, handoff, and runtime-request items. Large item text is
bounded and reports whether it was truncated. `afterPosition` and
`nextPosition` support incremental reads.

Thread and message results include required `createdBy` and `creationSource`
provenance. MCP-created threads and user-role messages use `createdBy: "agent"`
and `creationSource: "mcp"`; provider output uses `creationSource: "provider"`.
Actor and ingress are separate so agent-authored user-role messages remain
distinguishable from human-authored messages.

Agents mention another thread as `[title](t3-thread://v1/<threadId>)`. Thread
results carry this ready-made as `link`, so agents never format the id. The
link carries only the id. Clients first resolve it in the message's environment,
then use a unique match in another enabled environment. Ambiguous matches stay
unresolved. Web and desktop show the resolved thread’s current title. Mobile
relabels local matches; cross-environment links can retain the written label.

List and read results report `snoozed` and `snoozedUntil`, and
`t3_thread_list` filters on `snoozed`. The server's `isSnoozed` follows the
client's `effectiveSnoozed`, so agents and the sidebar agree: a snoozed thread
wakes early only when it has a pending request or fails after snoozing. Completed
runs, background wakes, and delegated completions keep it snoozed.

### `t3_thread_update`

Updates metadata for the calling thread or any other thread in the environment.
The typed actions are `rename`, `regenerate_title`, `link_pull_request`, and
`unlink_pull_request`. A link input supplies the repository, number, and URL;
the server records the target thread's project ID. Branch and workspace changes
are outside this tool.

The result includes the command ID and durable event sequence together with the
resultant title, title-regeneration marker, and linked pull request. Reusing a
`clientRequestId` for the same action and thread replays the same command
receipt. Thread list and read results expose the linked pull request, and thread
detail also exposes an in-flight title regeneration.

### `t3_thread_send`

Sends a message to any ordinary or delegated thread in the environment:

- `auto` starts an idle thread, steers a fully active turn, or queues behind a
  turn that is not yet steerable;
- `queue` creates a separate follow-up run after active work;
- `steer` requires a steerable active provider turn; and
- `restart` requires an active provider turn and uses the orchestrator's
  interrupt-and-restart path.

The target runtime and interaction modes may not be broader than the caller's.
Stable command and message IDs are derived from `clientRequestId` for
idempotent retries.

### `t3_thread_wait`

Waits for a selected run to become `completed`, `failed`, `cancelled`,
`interrupted`, or `rolled_back`. Without `runId`, it pins the latest run at call
time; an idle thread returns immediately. A timeout reports the latest durable
status and does not cancel work.

### `t3_thread_interrupt`

Interrupts a selected active run through the normal V2 `run.interrupt` command.
Without `runId`, it selects the newest interruptible run. A terminal run is
returned unchanged, and a thread with no active provider turn returns
`no_active_run`.

## Delegated Task Lifecycle

The MCP server is a command ingress into V2. It does not call provider adapters
directly.

```text
provider model
  -> MCP tools/call delegate_task
  -> authenticated OrchestratorMcpService
  -> shared ThreadManagementService
  -> V2 delegated_task.request command
  -> child thread + child run
  -> parent app_owned subagent projection
  -> parent/child execution nodes
  -> consumed subagent_spawn context transfer
  -> normal provider effect and runtime ingestion
  -> child run reaches a terminal state
  -> parent subagent/node/turn item finalized
  -> consumed subagent_result context transfer
  -> wait result or later task_status result
```

The child thread has lineage relationship `subagent` and points back to the
parent node. The parent gets an `app_owned` sub-agent projection and a
sub-agent turn item so the existing debug UI can render progress.

Terminal provider events trigger finalization. The event stream first replays
persisted events and then follows live events, so finalization also runs after
a server restart. An existing `subagent_result` transfer makes finalization
idempotent.

Users rarely watch child threads, so a child question would otherwise go
unanswered. When a child opens a pending `user_input` request, the parent gets
a notification message telling it to answer with the pending request tools or
ask the user. The message says whether the child is blocked or, for a Codex
async question, still working. If the question is answered or dismissed before
the notification starts a turn, that queued turn is cancelled. Approvals are not
routed, because those tools cannot answer them.
A parent still blocked in a `delegate_task` wait gets the blocking question
through that wait instead.
If the provider cuts that wait short, a still-pending live question wakes the
parent when its launching run completes, fails, or waits for post-turn work.
Stopping or interrupting the parent prevents this catch-up.

A failed run exposes its provider error before any progress text. Successful
results use the latest assistant content from the final work turn.

## Policy And Idempotency

- A child runtime mode may stay equal to or become narrower than the parent
  mode. It may not escalate privileges.
- A child interaction mode may stay equal to or narrow from `default` to
  `plan`. It may not escalate from `plan` to `default`.
- Thread tools take any thread in the environment as a target. For a thread
  caller, list and search cover one project: its own unless `projectId` is given.
- A tool that changes another thread needs the calling thread's live run, and
  the target's runtime and interaction modes may not be broader than the
  caller's. This is the same privilege ceiling as child creation.
- Provider instances must be enabled, installed, available, authenticated, and
  backed by a V2 adapter.
- A requested model must be advertised by the selected provider when the
  provider publishes a model list.
- `clientRequestId` derives stable command, thread, and message IDs within the
  provider session. Retrying the same call returns the same durable work.
- Calls without `clientRequestId` receive a generated request key and create
  new work.

Expected denials use the typed `OrchestratorMcpFailure` result:

```text
capability_denied
parent_not_active
provider_unavailable
model_unavailable
runtime_mode_escalation_denied
interaction_mode_escalation_denied
task_not_found
task_not_cancellable
thread_not_found
run_not_found
thread_not_sendable
thread_not_interruptible
invalid_request
orchestration_error
```

## Code Ownership

- Shared schemas: `packages/contracts/src/orchestratorMcp.ts` and
  `packages/contracts/src/threadMetadataMcp.ts`
- MCP services: `apps/server/src/mcp/OrchestratorMcpService.ts` and the focused
  `apps/server/src/mcp/ThreadMetadataMcpService.ts`
- Tool definitions and handlers:
  `apps/server/src/mcp/toolkits/orchestrator/`
- HTTP registration and authentication:
  `apps/server/src/mcp/McpHttpServer.ts`
- Credential lifecycle: `apps/server/src/mcp/McpSessionRegistry.ts`
- Provider injection:
  `apps/server/src/orchestration-v2/ProviderSessionManager.ts` and V2 adapters
- Durable delegated-task command and finalization:
  `apps/server/src/orchestration-v2/Orchestrator.ts`

## Verification

The integration test uses the real MCP toolkit registration, V2 orchestrator,
SQL persistence, event ingestion, projections, and checkpoints. Only the
external provider adapters are deterministic test implementations.

Coverage includes:

- capability discovery;
- cross-provider delegated completion;
- prompt-only child context;
- parent and child lineage projections;
- spawn and result context transfers;
- async status polling;
- cancellation;
- batch delegation, task waits, structured results and the running limit;
- workflow scripts: phases, parallel and pipeline steps, one completion delivery,
  resume after a restart without duplicate agents, retries of failed,
  restart-cancelled and stalled agents, the token budget, the agent cap, and
  per-agent worktrees;
- workflow schema results, script errors, and Stop through `workflow_stop`, `task_cancel`
  and the calling thread;
- attempt deadlines, and graphs: review binding inputs without recording anything,
  refusals of blockers, a wrong digest and a changed input, a passing graph's per-node
  record and single wake, a failed node skipping its dependents, and Stop;
- batch ordinary-thread creation;
- thread listing and timeline reads, including another project's threads;
- ordinary-thread send, wait, steering, and interruption;
- inheritance and per-thread provider overrides; and
- idempotent retries.

Provider adapter tests separately verify Codex, Claude, Cursor, Grok, and ACP
Registry behavior and MCP injection. The provider-session manager test verifies
that credentials exist before an adapter opens and are revoked when it closes.

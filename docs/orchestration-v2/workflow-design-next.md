# Workflow runner: measured costs and next design steps

Status: design note. Section 1 is shipped; sections 2 to 6 are proposals awaiting implementation.
Evidence comes from the M7 live runs (the fan-in and serial graphs from the omx graph benchmarks,
on the codex driver through a proxy and on the claudeAgent driver, with Claude Haiku 5.5). It is a
small sample: one run per configuration, on tiny tasks.

## What the measurements showed

- **Member agents fill 97 to 99% of a graph's run time.** Coordinator turns (17-32 s) overlap
  startup. Gaps between dependent nodes are 0.4-2.1 s. The runner itself adds little: it waits on
  events, not polling.
- **Within a member, the model turn is only 57% of its life.** The rest is T3's own work:
  - 24%: a baseline git snapshot before the turn, plus session start;
  - 18%: the checkpoint capture after the turn.

  The capture is about 10 serial git processes on a checkout with 28k tracked files. A per-checkout
  lock queues members that share a checkout behind each other and behind the coordinator's own
  capture. In one example, the fan-in summary member took 87 s in total, of which 36 s was its
  model turn and 36 s its capture.

- **Codex prompt caching is per thread.** In the observed run, every new thread cached the same
  58,794-token prefix on its first response, and a sibling that started 11.6 s later gained
  nothing. After the first response, a thread caches almost all of its context. About 46k tokens
  per member stay uncached on the first request.
- **The old token count was wrong.** It summed the context size of each final response.
  `workflowUsage.ts` now sums cumulative usage per turn, with cached and uncached input kept
  separate.

## 1. Take a member's result at turn end (shipped)

A completed turn persists its run as `waiting` until the checkpoint capture lands. For workflow
members only, the orchestrator now settles the delegated task when the run reaches `waiting`
(`settledWorkflowMemberRun` in `Orchestrator.ts`). The capture still runs and completes the run, so
diffs, revert, rewind and turn summaries are unchanged. Ordinary delegated tasks still settle after
their capture.

What this changes:

- The workflow's critical path no longer includes each member's capture.
- The next member may still wait on the checkout lock before its baseline snapshot. Section 2 is
  about that.
- The running-agent limit still counts a member until its capture completes. That is conservative,
  and it stays this way.

## 2. Cut the baseline snapshot cost for members sharing a checkout (proposal)

The baseline snapshot before each member's turn, and lock contention with siblings, are the
largest remaining T3-owned cost. The safe target is to share work, not to skip checkpoints. These
readers need each member's checkpoints:

- turn and full-thread diffs (`CheckpointDiffQuery.ts`);
- revert, including conversation-only rewind (client-runtime `commands.ts`; `Orchestrator.ts`);
- turn-diff summaries (`threadCheckpoints.ts`);
- the web diff panel, timeline and rewind.

Options, cheapest first:

1. **Reuse the workflow's baseline.** Members that start together from the same checkout state can
   all point their baseline ref at one snapshot, taken once by the runner before it spawns them.
   Each member keeps its own ref, so every reader works unchanged. This needs a way to pass a
   prepared tree into `captureBaseline`, and a check that the tree still matches the checkout.
2. **Make one snapshot cheaper.** Use `git write-tree` from a temporary index seeded from the
   previous snapshot (`git read-tree` and then `update-index --refresh`), instead of a full
   `add -A` on 28k files. This helps every thread, not just workflows.
3. **Narrow the lock.** Reads such as diffs do not need the per-checkout write lock.

Gate: on the M7 fan-in, member time before the turn drops by at least half, and every reader
listed above works on member threads (tested, not assumed).

## 3. A smaller context per member (proposal, gated by an experiment)

T3 cannot narrow a member's context today. The skills list (about 74k characters) and AGENTS.md
(about 29k) come from Codex's own loader, and every thread gets the same MCP toolkit. Two levers
are candidates:

- **Codex:** `skills.include_instructions=false` in the per-thread `config` of `thread/start`.
  Codex 0.163.0 contains the key, and T3's fixture recorder already sends it. Its effect is
  untested. Experiment X2: send it to one member only, then compare first-request input tokens and
  the rollout's skills section against a control member and an untouched sibling. It passes if
  input drops by at least 20k tokens for the treated member only.
- **All drivers:** a member capability set narrower than the thread default. Members already lose
  `orchestration`. The MCP server could also stop listing tools a credential cannot call, which
  shrinks the tool schemas sent to the model.

## 4. Benchmark on real tasks (proposal)

Run three task families, with acceptance criteria fixed before any run:

1. a review of a real historical diff, split across three areas, with known defects;
2. a multi-file change with held-out tests, using one writer plus a verifier;
3. a serial control.

Run each family 3 times as a graph and 3 times as one ordinary thread (no workflow, no
coordinator). The M7 "solo" runs were one-node graphs and do not count as single-agent runs.

For families 1 and 2 to pass:

- verified quality is equal;
- median end-to-end time, including the coordinator, is at least 25% lower;
- cumulative and uncached usage are each within 2x;
- no child is still running 60 s after Stop;
- a restart resumes within 120 s with no duplicate work.

The control should tie or lose. Report every run. If neither family wins, ship the guidance below
and stop adding features.

## 5. Guidance (from evidence so far)

Fan out for reading and review. Keep writes in one agent. Verify results centrally. Published
studies agree:

- Multi-agent runs win on decomposable, read-heavy work.
- They lose on sequential planning, and on tasks one agent already does well.
- A central verifier sharply reduces compounding errors.

No study found peer-to-peer messaging between agents beating a manager plus shared state for
coding.

## 6. Deferred

- Output snapshots, so producers can run in worktrees.
- Provider fallback lanes. These need the typed outcome categories from A0 to tell "never started"
  apart from a failure after work began.
- Peer messaging between agents.
- A scale ladder at 25, 100 and 250 agents.
- Side-by-side comparison with Claude Code's own Workflow tool.

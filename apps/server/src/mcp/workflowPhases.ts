import type { OrchestrationV2WorkflowPhase } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { MAX_AGENTS_PER_WORKFLOW } from "./workflowLimits.ts";

const MAX_PHASES = 4096;
const decodeTitle = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
);
const decodeTotal = Schema.decodeUnknownSync(
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_AGENTS_PER_WORKFLOW),
  ),
);

/** Phase indices survive resume even when concurrent callbacks enter in a different order. */
export class WorkflowPhases {
  private readonly rows: OrchestrationV2WorkflowPhase[];
  private readonly entered = new Set<number>();

  constructor(previous: ReadonlyArray<OrchestrationV2WorkflowPhase> = []) {
    this.rows = [...previous];
  }

  declare(title: string, total?: unknown): OrchestrationV2WorkflowPhase {
    if (total !== undefined) decodeTitle(title);
    const existing = this.rows.find((phase) => phase.title === title);
    if (total === undefined && existing !== undefined) return existing;
    const progress =
      total === undefined ? undefined : { total: decodeTotal(total), state: "planned" as const };
    if (existing !== undefined) {
      if (this.entered.has(existing.index))
        throw new Error("Cannot redeclare an entered progress phase.");
      if (existing.progress !== undefined && existing.progress.state !== "planned") return existing;
      const phase = { ...existing, progress };
      this.replace(phase);
      return phase;
    }
    if (this.rows.length >= MAX_PHASES)
      throw new Error(`A workflow supports at most ${MAX_PHASES} phases.`);
    const phase = {
      index: Math.max(-1, ...this.rows.map((row) => row.index)) + 1,
      title,
      ...(progress === undefined ? {} : { progress }),
    };
    this.rows.push(phase);
    return phase;
  }

  start(title: unknown, total: unknown, occupied: ReadonlyArray<number> = []): number {
    const name = decodeTitle(typeof title === "string" ? title.trim() : title);
    const planned = decodeTotal(total);
    const phase = this.declare(name);
    if (occupied.includes(phase.index))
      throw new Error("A progress phase must start before its agents.");
    if (this.entered.has(phase.index))
      throw new Error("Each progress phase title may be entered only once per run.");
    this.entered.add(phase.index);
    this.replace({ ...phase, progress: { total: planned, state: "running" } });
    return phase.index;
  }

  member(index: number, observed: number): OrchestrationV2WorkflowPhase {
    const phase = this.rows.find((row) => row.index === index);
    if (phase?.progress?.state !== "running") throw new Error("This progress phase is closed.");
    if (observed >= phase.progress.total)
      throw new Error("Progress phase capacity exceeded; size the next phase at entry.");
    return phase;
  }

  close(index: number, state: "completed" | "failed"): void {
    const phase = this.rows.find((row) => row.index === index);
    if (phase?.progress?.state !== "running") throw new Error("This progress phase is closed.");
    this.replace({ ...phase, progress: { ...phase.progress, state } });
  }

  failOpen(): boolean {
    let failed = false;
    for (const phase of this.rows) {
      if (phase.progress?.state === "running") {
        this.close(phase.index, "failed");
        failed = true;
      }
    }
    return failed;
  }

  snapshot(): ReadonlyArray<OrchestrationV2WorkflowPhase> {
    return [...this.rows];
  }

  private replace(phase: OrchestrationV2WorkflowPhase): void {
    this.rows[this.rows.findIndex((row) => row.index === phase.index)] = phase;
  }
}

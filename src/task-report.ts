/**
 * Task run report — phases and elapsed-time helpers.
 * Owned by the Task module; not a public package export surface.
 */

export type TaskPhase = "queued" | "running" | "completed" | "failed" | "aborted";

/** Deterministic injectable clock (epoch ms). Not part of the public package API. */
export type Clock = () => number;

export function defaultClock(): number {
  return Date.now();
}

/**
 * Tracks wall time from Task start. Public details only receive non-negative
 * `elapsedMs` — no startedAt nesting or sub-phase timing.
 */
export interface TimingTracker {
  /** Wall time from start to now, always ≥ 0. */
  elapsedMs(): number;
}

export function createTimingTracker(clock: Clock): TimingTracker {
  const startedAt = clock();

  return {
    elapsedMs(): number {
      const now = clock();
      return Math.max(0, now - startedAt);
    },
  };
}

export function formatPhaseProgressText(options: {
  phase: TaskPhase;
  agentName: string;
  description: string;
  /** Current tool name/status line (running phase only). */
  toolPreview?: string;
}): string {
  const { phase, agentName, description, toolPreview } = options;
  const head = `${labelForPhase(phase)} ${agentName}: ${description}`;
  if (phase === "running" && toolPreview) {
    return `${head}\n${toolPreview}`;
  }
  return head;
}

function labelForPhase(phase: TaskPhase): string {
  switch (phase) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "aborted":
      return "Aborted";
  }
}

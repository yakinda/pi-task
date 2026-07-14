/**
 * Process-level concurrency gate: max N concurrent holders; additional callers wait.
 * Abort while waiting cancels without acquiring.
 */

export interface SemaphoreWaitSnapshot {
  active: number;
  waiting: number;
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    onAbort: () => void;
  }> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error("Semaphore max must be >= 1");
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  get maxCount(): number {
    return this.max;
  }

  /**
   * Acquire a slot. If a slot is not immediately available, `onWait` is invoked
   * once with a best-effort active/waiting snapshot (waiting includes this caller).
   */
  async acquire(
    signal?: AbortSignal,
    onWait?: (snapshot: SemaphoreWaitSnapshot) => void,
  ): Promise<() => void> {
    if (signal?.aborted) {
      throw abortError();
    }

    if (this.active < this.max) {
      this.active += 1;
      return this.makeRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry = {
        resolve: () => {
          cleanup();
          this.active += 1;
          resolve(this.makeRelease());
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
        onAbort: () => {
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          cleanup();
          reject(abortError());
        },
      };

      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", entry.onAbort);
      };

      if (signal) signal.addEventListener("abort", entry.onAbort, { once: true });
      this.waiters.push(entry);
      try {
        onWait?.({ active: this.active, waiting: this.waiters.length });
      } catch {
        // Queue observation must not strand a waiter or alter semaphore accounting.
      }

      // Re-check abort after enqueue (race)
      if (signal?.aborted) {
        entry.onAbort();
      }
    });
  }

  /**
   * Build an idempotent release closure for one acquire.
   * Calling it twice must not decrement active twice or admit extra waiters.
   */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next.resolve();
  }
}

function abortError(): Error {
  const err = new Error("Aborted while waiting for task slot");
  err.name = "AbortError";
  return err;
}

/** Shared process-level semaphore for task children (max 4). */
export const taskSemaphore = new Semaphore(4);

import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/semaphore.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

describe("Semaphore", () => {
  it("limits concurrent holders to max", async () => {
    const sem = new Semaphore(4);
    let concurrent = 0;
    let maxSeen = 0;
    const releaseGates: Array<() => void> = [];

    const started = Array.from({ length: 8 }, async () => {
      const release = await sem.acquire();
      concurrent += 1;
      maxSeen = Math.max(maxSeen, concurrent);
      await new Promise<void>((resolve) => releaseGates.push(resolve));
      concurrent -= 1;
      release();
    });

    for (let i = 0; i < 50 && releaseGates.length < 4; i++) await Promise.resolve();
    expect(maxSeen).toBe(4);
    expect(releaseGates.length).toBe(4);

    const first = releaseGates.splice(0, 4);
    for (const r of first) r();
    for (let i = 0; i < 50 && releaseGates.length < 4; i++) await Promise.resolve();
    expect(maxSeen).toBe(4);
    for (const r of releaseGates.splice(0)) r();
    await Promise.all(started);
    expect(maxSeen).toBe(4);
  });

  it("fifth waits until a slot frees", async () => {
    const sem = new Semaphore(4);
    const releases: Array<() => void> = [];
    for (let i = 0; i < 4; i++) releases.push(await sem.acquire());

    let fifthStarted = false;
    const fifth = sem.acquire().then((release) => {
      fifthStarted = true;
      release();
    });

    await Promise.resolve();
    expect(fifthStarted).toBe(false);
    expect(sem.waitingCount).toBe(1);

    releases[0]();
    await fifth;
    expect(fifthStarted).toBe(true);
    for (const r of releases.slice(1)) r();
  });

  it("abort while waiting never acquires", async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    const ac = new AbortController();

    const waiting = sem.acquire(ac.signal);
    await Promise.resolve();
    ac.abort();

    await expect(waiting).rejects.toThrow(/Aborted while waiting/);
    expect(sem.activeCount).toBe(1);
    hold();
    expect(sem.activeCount).toBe(0);
    expect(sem.waitingCount).toBe(0);
  });

  it("onWait fires only when queued with best-effort counts", async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    const snapshots: Array<{ active: number; waiting: number }> = [];

    const waiting = sem.acquire(undefined, (s) => snapshots.push(s));
    await Promise.resolve();
    expect(snapshots).toEqual([{ active: 1, waiting: 1 }]);

    hold();
    const release = await waiting;
    expect(sem.activeCount).toBe(1);
    release();
    expect(sem.activeCount).toBe(0);
  });

  it("immediate acquire does not invoke onWait", async () => {
    const sem = new Semaphore(1);
    let called = false;
    const release = await sem.acquire(undefined, () => {
      called = true;
    });
    expect(called).toBe(false);
    release();
  });

  it("double release is not required; single release frees one waiter", async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();
    const g = gate();
    let secondActive = false;
    const second = sem.acquire().then((release) => {
      secondActive = true;
      g.release();
      release();
    });
    await Promise.resolve();
    expect(secondActive).toBe(false);
    first();
    await g.promise;
    await second;
    expect(sem.activeCount).toBe(0);
  });

  it("release closure is idempotent — double call does not admit extra waiters", async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();

    let secondEntered = 0;
    let thirdEntered = 0;
    const secondHold = gate();
    const thirdHold = gate();

    const second = sem.acquire().then(async (release) => {
      secondEntered += 1;
      await secondHold.promise;
      release();
    });
    const third = sem.acquire().then(async (release) => {
      thirdEntered += 1;
      await thirdHold.promise;
      release();
    });

    for (let i = 0; i < 10 && sem.waitingCount < 2; i++) await Promise.resolve();
    expect(sem.activeCount).toBe(1);
    expect(sem.waitingCount).toBe(2);
    expect(secondEntered).toBe(0);
    expect(thirdEntered).toBe(0);

    // Double-release of the first holder must free only one waiter.
    first();
    first();
    for (let i = 0; i < 20 && secondEntered === 0; i++) await Promise.resolve();

    expect(secondEntered).toBe(1);
    expect(thirdEntered).toBe(0);
    expect(sem.activeCount).toBe(1);
    expect(sem.waitingCount).toBe(1);

    secondHold.release();
    await second;
    for (let i = 0; i < 20 && thirdEntered === 0; i++) await Promise.resolve();

    expect(thirdEntered).toBe(1);
    expect(sem.activeCount).toBe(1);
    expect(sem.waitingCount).toBe(0);

    thirdHold.release();
    await third;
    expect(sem.activeCount).toBe(0);
    expect(sem.waitingCount).toBe(0);
  });

  it("does not strand a waiter when the queue observer throws", async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();

    const waiting = sem.acquire(undefined, () => {
      throw new Error("observer failed");
    });
    await Promise.resolve();
    expect(sem.activeCount).toBe(1);
    expect(sem.waitingCount).toBe(1);

    first();
    const second = await waiting;
    expect(sem.activeCount).toBe(1);
    expect(sem.waitingCount).toBe(0);
    second();
    expect(sem.activeCount).toBe(0);
  });
});

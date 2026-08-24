/**
 * Admission control for chunk reads.
 *
 * Two things have to be true at once. Peak memory must stay bounded however
 * fast the user zooms, and a viewport's worth of chunks must not be served one
 * dozen at a time when most of them are small — a single z step asks for
 * hundreds of chunks, and at a coarse level each is a few hundred kilobytes
 * over a network filesystem, where the cost is latency rather than bandwidth.
 *
 * So the limit is a **budget of bytes in flight** rather than a count. A
 * full-resolution chunk holds nine megabytes of working set and gets about ten
 * slots; a coarse one holds a few hundred kilobytes and gets as many as the
 * concurrency ceiling allows. The same budget covers both.
 *
 * The other half is letting go. Neuroglancer cancels the chunks it no longer
 * needs the moment the view moves, which is what keeps it responsive — but only
 * if the other side listens. A queue that holds on to cancelled work makes the
 * requests that replaced it wait behind reads whose results are already being
 * discarded, which is exactly the pause a user notices after panning. Waiting
 * tasks are dropped as soon as their request is aborted, and a task that was
 * cancelled before it started never reads anything at all.
 */

export class AbortError extends Error {
  override readonly name = 'AbortError';

  constructor() {
    super('The request was cancelled.');
  }
}

interface Waiter {
  cost: number;
  signal: AbortSignal | undefined;
  admit: () => void;
  drop: () => void;
}

export interface Gate {
  /**
   * Run `task` once `cost` bytes of working set fit within the budget.
   *
   * Rejects with {@link AbortError} if `signal` aborts before the task starts.
   * Once it has started the task runs to completion: the reads it makes are
   * already in flight, and unwinding them would cost more than finishing.
   */
  run<T>(cost: number, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Bytes currently admitted. */
  readonly inFlight: number;
  /** Tasks currently admitted. */
  readonly running: number;
  /** Tasks waiting for room. */
  readonly queued: number;
}

export function createGate(options: { budget: number; maxConcurrent: number }): Gate {
  const { budget, maxConcurrent } = options;
  const waiting: Waiter[] = [];
  let inFlight = 0;
  let running = 0;

  /** Whether a task of this size can start right now. */
  const fits = (cost: number): boolean => {
    if (running >= maxConcurrent) return false;
    // A task larger than the whole budget would otherwise never run, so let it
    // through when it can have the budget to itself.
    return running === 0 || inFlight + cost <= budget;
  };

  const admitWaiting = (): void => {
    while (waiting.length > 0) {
      const next = waiting[0];
      if (next.signal?.aborted) {
        waiting.shift();
        next.drop();
        continue;
      }
      if (!fits(next.cost)) return;
      waiting.shift();
      inFlight += next.cost;
      running += 1;
      next.admit();
    }
  };

  const acquire = (cost: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new AbortError());
    if (waiting.length === 0 && fits(cost)) {
      inFlight += cost;
      running += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        cost,
        signal,
        admit: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        drop: () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new AbortError());
        },
      };
      function onAbort(): void {
        const index = waiting.indexOf(waiter);
        if (index !== -1) waiting.splice(index, 1);
        waiter.drop();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(waiter);
    });
  };

  return {
    async run(cost, task, signal) {
      const size = Math.max(1, Math.round(cost));
      await acquire(size, signal);
      try {
        return await task();
      } finally {
        inFlight -= size;
        running -= 1;
        admitWaiting();
      }
    },
    get inFlight() {
      return inFlight;
    },
    get running() {
      return running;
    },
    get queued() {
      return waiting.length;
    },
  };
}

/**
 * Admission control for chunk reads.
 *
 * Two things have to be true at once. Peak memory must stay bounded however
 * fast the user zooms, and a viewport's worth of chunks must not be served a
 * dozen at a time when each is small — a single z step asks for hundreds of
 * them over a filesystem that may well be remote, where the cost is latency
 * rather than bandwidth.
 *
 * So the limit is a **budget of bytes in flight** rather than a count. A chunk
 * is a field of view, and a large one holds nine megabytes of working set and
 * gets about ten slots where a small one gets as many as the concurrency
 * ceiling allows. The same budget covers both.
 *
 * The other half is letting go. Neuroglancer cancels the chunks it no longer
 * needs the moment the view moves, which is what keeps it responsive — but only
 * if the other side listens. A queue that holds on to cancelled work makes the
 * requests that replaced it wait behind reads whose results are already being
 * discarded, which is exactly the pause a user notices after panning. Waiting
 * tasks are dropped as soon as their request is aborted, and a task that was
 * cancelled before it started never reads anything at all.
 */

/**
 * How much chunk work may be in flight at once, in bytes of working set.
 *
 * Bounding memory by *bytes* rather than by a count is what lets acquisitions
 * of different shapes share one setting. A chunk is a field of view, and a
 * field of view is whatever the objective and camera made it: nine megabytes of
 * working set at 2000 px square, a fraction of that from a smaller sensor.
 */
export const CHUNK_BUDGET_BYTES = 96 * 1024 * 1024;

/**
 * A ceiling on concurrent reads, whatever the budget says.
 *
 * Small chunks would otherwise fan out to hundreds of simultaneous opens, which
 * stops helping well before that and starts competing with itself.
 */
export const MAX_CONCURRENT_CHUNKS = 64;

/**
 * How many chunks of a given cost this budget will run at once.
 *
 * Exported because the viewer needs to know: a client that asks for far more
 * at a time than the server can work on turns its own priority queue into a
 * queue it cannot reorder. See `integrations/neuroglancer.ts`.
 */
export function concurrentChunks(cost: number): number {
  return Math.max(
    1,
    Math.min(MAX_CONCURRENT_CHUNKS, Math.floor(CHUNK_BUDGET_BYTES / Math.max(1, cost))),
  );
}

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

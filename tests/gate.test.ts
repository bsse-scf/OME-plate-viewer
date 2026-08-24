/**
 * Admission control: the budget, and letting go of cancelled work.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AbortError, createGate } from '../src/vfs/gate';

/** A task that finishes when told to. */
function deferred() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { done, release };
}

const MB = 1024 * 1024;

test('admits as many tasks as the byte budget allows', async () => {
  const gate = createGate({ budget: 10 * MB, maxConcurrent: 64 });
  const started: number[] = [];
  const blocks = Array.from({ length: 6 }, () => deferred());

  const runs = blocks.map((block, index) =>
    gate.run(3 * MB, async () => {
      started.push(index);
      await block.done;
    }),
  );

  await Promise.resolve();
  await Promise.resolve();
  // 3 MB each into a 10 MB budget: three fit, the rest wait.
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(gate.queued, 3);

  blocks[0].release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, [0, 1, 2, 3]);

  for (const block of blocks) block.release();
  await Promise.all(runs);
  assert.equal(gate.inFlight, 0);
  assert.equal(gate.running, 0);
});

test('small tasks get far more slots than large ones', async () => {
  const gate = createGate({ budget: 10 * MB, maxConcurrent: 64 });
  const blocks = Array.from({ length: 40 }, () => deferred());
  const runs = blocks.map((block) => gate.run(64 * 1024, () => block.done));

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gate.running, 40, 'small chunks should all be admitted');

  for (const block of blocks) block.release();
  await Promise.all(runs);
});

test('never admits more than the concurrency ceiling', async () => {
  const gate = createGate({ budget: 1024 * MB, maxConcurrent: 4 });
  const blocks = Array.from({ length: 10 }, () => deferred());
  const runs = blocks.map((block) => gate.run(1024, () => block.done));

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gate.running, 4);
  assert.equal(gate.queued, 6);

  for (const block of blocks) block.release();
  await Promise.all(runs);
});

test('a task larger than the budget still runs, alone', async () => {
  const gate = createGate({ budget: 1 * MB, maxConcurrent: 64 });
  let ran = false;
  await gate.run(50 * MB, async () => {
    ran = true;
  });
  assert.ok(ran);
});

test('a cancelled task never starts, and frees its place at once', async () => {
  const gate = createGate({ budget: 1 * MB, maxConcurrent: 1 });
  const blocking = deferred();
  const running = gate.run(1 * MB, () => blocking.done);

  const controller = new AbortController();
  let started = false;
  const cancelled = gate.run(
    1 * MB,
    async () => {
      started = true;
    },
    controller.signal,
  );

  const wanted = deferred();
  let wantedStarted = false;
  const replacement = gate.run(1 * MB, async () => {
    wantedStarted = true;
    await wanted.done;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gate.queued, 2);

  // The view moved: Neuroglancer drops the chunk it no longer needs.
  controller.abort();
  await assert.rejects(cancelled, AbortError);
  assert.equal(started, false, 'a cancelled task must not read anything');
  assert.equal(gate.queued, 1, 'it must leave the queue immediately');

  blocking.release();
  await running;
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The request that replaced it starts without waiting for anything else.
  assert.equal(wantedStarted, true);
  wanted.release();
  await replacement;
});

test('a task cancelled before it is offered a slot is rejected', async () => {
  const gate = createGate({ budget: 1 * MB, maxConcurrent: 8 });
  const controller = new AbortController();
  controller.abort();
  let started = false;
  await assert.rejects(
    gate.run(1024, async () => {
      started = true;
    }, controller.signal),
    AbortError,
  );
  assert.equal(started, false);
  assert.equal(gate.running, 0);
});

test('cancelled waiters are skipped when room appears', async () => {
  const gate = createGate({ budget: 1 * MB, maxConcurrent: 1 });
  const blocking = deferred();
  const running = gate.run(1 * MB, () => blocking.done);

  const controllers = [new AbortController(), new AbortController()];
  const abandoned = controllers.map((controller) =>
    gate.run(1 * MB, async () => 'should not run', controller.signal).catch((e) => e.name),
  );
  const wanted = gate.run(1 * MB, async () => 'ran');

  for (const controller of controllers) controller.abort();
  blocking.release();
  await running;

  assert.deepEqual(await Promise.all(abandoned), ['AbortError', 'AbortError']);
  assert.equal(await wanted, 'ran');
  assert.equal(gate.queued, 0);
  assert.equal(gate.running, 0);
});

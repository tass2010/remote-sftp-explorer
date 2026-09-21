import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PathLockRegistry } from '../src/locks/pathLockRegistry.ts';

/**
 * Flush pending microtasks. `withWriteLock` awaits one acquisition per key before running the
 * body, so a single `await Promise.resolve()` is not enough to observe it having started.
 */
async function settle(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('two writes to the same path do not overlap', async () => {
  const locks = new PathLockRegistry();
  const order: string[] = [];
  const first = deferred();

  const a = locks.withWriteLock('/dir/file', async () => {
    order.push('a:start');
    await first.promise;
    order.push('a:end');
  });
  const b = locks.withWriteLock('/dir/file', async () => {
    order.push('b:start');
  });

  await settle();
  assert.deepEqual(order, ['a:start'], 'the second write must wait');

  first.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start']);
});

test('writes to different files in the same directory serialise on the parent', async () => {
  // Both change the directory's contents, so they must not interleave.
  const locks = new PathLockRegistry();
  const order: string[] = [];
  const gate = deferred();

  const a = locks.withWriteLock('/dir/one', async () => {
    order.push('one:start');
    await gate.promise;
    order.push('one:end');
  });
  const b = locks.withWriteLock('/dir/two', async () => {
    order.push('two:start');
  });

  await settle();
  assert.deepEqual(order, ['one:start']);

  gate.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['one:start', 'one:end', 'two:start']);
});

test('writes in unrelated directories run concurrently', async () => {
  const locks = new PathLockRegistry();
  const started: string[] = [];
  const gate = deferred();

  const a = locks.withWriteLock('/alpha/file', async () => {
    started.push('alpha');
    await gate.promise;
  });
  const b = locks.withWriteLock('/beta/file', async () => {
    started.push('beta');
    await gate.promise;
  });

  await settle();
  assert.deepEqual(started.sort(), ['alpha', 'beta'], 'neither should block the other');

  gate.resolve();
  await Promise.all([a, b]);
});

test('waiters on a path are served in arrival order', async () => {
  const locks = new PathLockRegistry();
  const order: number[] = [];
  const gate = deferred();

  const first = locks.withWriteLock('/f', async () => {
    order.push(0);
    await gate.promise;
  });
  await settle();

  const rest = [1, 2, 3, 4].map((index) =>
    locks.withWriteLock('/f', async () => {
      order.push(index);
    })
  );

  gate.resolve();
  await Promise.all([first, ...rest]);
  assert.deepEqual(order, [0, 1, 2, 3, 4], 'FIFO fairness: nothing may be starved');
});

test('the lock is released when the operation throws', async () => {
  const locks = new PathLockRegistry();
  await assert.rejects(
    () =>
      locks.withWriteLock('/f', async () => {
        throw new Error('boom');
      }),
    /boom/
  );
  assert.equal(locks.heldCount, 0, 'a failed operation must not wedge the lock');

  // The path is immediately usable again.
  await locks.withWriteLock('/f', async () => undefined);
});

test('acquiring two keys in sorted order cannot deadlock', async () => {
  // Sorted acquisition means two operations wanting the same pair always take them in the
  // same sequence, so neither can hold one while waiting for the other.
  const locks = new PathLockRegistry();
  const results: string[] = [];

  await Promise.all([
    locks.withWriteLock('/a/b', async () => {
      results.push('first');
    }),
    locks.withWriteLock('/a/b', async () => {
      results.push('second');
    }),
    locks.withWriteLock('/a', async () => {
      results.push('parent');
    })
  ]);

  assert.equal(results.length, 3);
  assert.equal(locks.heldCount, 0);
});

test('nested paths lock their own parent, not the whole tree', async () => {
  const locks = new PathLockRegistry();
  const gate = deferred();
  const started: string[] = [];

  const deep = locks.withWriteLock('/root/a/b/file', async () => {
    started.push('deep');
    await gate.promise;
  });
  const sibling = locks.withWriteLock('/root/x/y/file', async () => {
    started.push('sibling');
  });

  await settle();
  assert.deepEqual(started.sort(), ['deep', 'sibling']);

  gate.resolve();
  await Promise.all([deep, sibling]);
});

test('one operation may hold two paths in the same directory without deadlocking itself', async () => {
  // Nesting two withWriteLock calls deadlocks whenever the paths share a parent: the inner
  // acquisition waits for a key the outer one still holds, and nothing will ever release it.
  // Sorted order makes concurrent operations safe against each other; only a combined
  // acquisition makes one operation safe against itself.
  const locks = new PathLockRegistry();

  const outcome = await Promise.race([
    locks.withWriteLocks(['/dir/old.txt', '/dir/new.txt'], async () => 'done'),
    new Promise((resolve) => setTimeout(() => resolve('DEADLOCKED'), 250))
  ]);

  assert.equal(outcome, 'done');
  assert.equal(locks.heldCount, 0, 'every key must be released');
});

test('a combined acquisition still excludes a concurrent writer under the same parent', async () => {
  const locks = new PathLockRegistry();
  const order: string[] = [];

  const first = locks.withWriteLocks(['/dir/a.txt', '/dir/b.txt'], async () => {
    order.push('first-in');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('first-out');
  });
  const second = locks.withWriteLock('/dir/c.txt', async () => {
    order.push('second');
  });

  await Promise.all([first, second]);
  assert.deepEqual(
    order,
    ['first-in', 'first-out', 'second'],
    'the shared parent must still serialise them'
  );
});

test('an operation over two directories releases both parents', async () => {
  const locks = new PathLockRegistry();
  await locks.withWriteLocks(['/one/a.txt', '/two/b.txt'], async () => {
    assert.equal(locks.isLocked('/one'), true);
    assert.equal(locks.isLocked('/two'), true);
    assert.equal(locks.isLocked('/one/a.txt'), true);
  });
  assert.equal(locks.heldCount, 0);
});

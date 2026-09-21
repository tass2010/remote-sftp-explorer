/**
 * A test harness small enough to read in one sitting.
 *
 * node:test's runner expects to own the process and discover files from disk; inside the
 * Extension Host it owns neither. Rather than fight that, or add mocha for one job, these
 * twenty lines do what is actually needed: run functions in order, catch what they throw,
 * print a legible log, and fail the run if anything failed.
 */

export interface Test {
  name: string;
  fn(): Promise<void> | void;
}

export interface Suite {
  name: string;
  before?(): Promise<void> | void;
  after?(): Promise<void> | void;
  tests: Test[];
}

export function suite(
  name: string,
  build: (test: (testName: string, fn: Test['fn']) => void) => Pick<Suite, 'before' | 'after'> | void
): Suite {
  const tests: Test[] = [];
  const hooks = build((testName, fn) => {
    tests.push({ name: testName, fn });
  });
  return { name, tests, ...(hooks ?? {}) };
}

export class AssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionFailure';
  }
}

export function ok(value: unknown, message: string): asserts value {
  if (value === false || value === undefined || value === null) {
    throw new AssertionFailure(message);
  }
}

export function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new AssertionFailure(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

export function deepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new AssertionFailure(`${message}\n  expected: ${b}\n  actual:   ${a}`);
}

export async function rejects(
  work: () => Promise<unknown>,
  matches: (error: unknown) => boolean,
  message: string
): Promise<void> {
  let thrown: unknown;
  let threw = false;
  try {
    await work();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  if (!threw) throw new AssertionFailure(`${message}: nothing was thrown`);
  if (!matches(thrown)) {
    throw new AssertionFailure(`${message}: wrong error -- ${String((thrown as Error)?.message ?? thrown)}`);
  }
}

/** Wait for a condition, so a test never depends on a fixed sleep being long enough. */
export async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new AssertionFailure(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function run(suites: readonly Suite[]): Promise<void> {
  let passed = 0;
  const failures: string[] = [];

  for (const current of suites) {
    console.log(`\n# ${current.name}`);
    try {
      await current.before?.();
    } catch (error) {
      // A failed setup would otherwise show as every test in the suite failing for reasons
      // that have nothing to do with them.
      failures.push(`${current.name} > before: ${describe(error)}`);
      console.log(`  ✖ before -- ${describe(error)}`);
      continue;
    }

    for (const test of current.tests) {
      try {
        await test.fn();
        passed += 1;
        console.log(`  ✔ ${test.name}`);
      } catch (error) {
        failures.push(`${current.name} > ${test.name}: ${describe(error)}`);
        console.log(`  ✖ ${test.name}\n      ${describe(error).split('\n').join('\n      ')}`);
      }
    }

    try {
      await current.after?.();
    } catch (error) {
      failures.push(`${current.name} > after: ${describe(error)}`);
      console.log(`  ✖ after -- ${describe(error)}`);
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} Extension Host test(s) failed:\n  ${failures.join('\n  ')}`);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

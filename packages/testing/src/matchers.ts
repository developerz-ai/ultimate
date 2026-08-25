// Custom expectations. Each one exists because the assertion it replaces was being written by
// hand, differently, in every test — and a hand-written version of "did this policy deny?" is how
// a test ends up asserting on the wrong branch.

import type { ExpectExtendMatchers } from 'bun:test';
import { expect } from 'bun:test';
import { describeValue, isUltimateError, stringField } from '@ultimat3/core';
import { TestJobExpectedError, TestSchemaExpectedError } from './errors';
import type { MatcherResult } from './matcher-result';
import type { UltimateMatchers } from './matcher-surface';
import type { VisibleOptions } from './matcher-visible';
import { assertVisibilityProbe, visibilityResult } from './matcher-visible';
import type { OpenApiLike } from './test-types';

export type { MatcherResult } from './matcher-result';
// Re-exported so the EMITTED `matchers.d.ts` still names `./matcher-surface`. A type-only import
// used by a non-exported const is elided from the declaration output, and with it goes the
// `bun:test` augmentation for anyone consuming this package through `dist/` — which is every
// package that reaches it across a project reference.
export type { UltimateMatchers } from './matcher-surface';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The Ultimate error code carried by `value`, or `undefined` for anything that is not one.
 *
 * Three parts, not one. "An object with a string `code`" passed a Node `ENOENT` — so a suite
 * pinning "never throw a bare Error" stayed green through exactly the regression it guards. The
 * contract is `X_SCREAMING_SNAKE` + a cause + an executable fix, which is the same two-part
 * discriminator `packages/cli/src/output.ts` uses to decide what the terminal shows.
 *
 * `stringField` and not a bare index: a matcher is asked about a value a test caught, and a
 * throwing getter or a `Proxy` here would raise INSIDE the assertion — replacing the test's real
 * failure with the matcher's.
 */
const codeOf = (value: unknown): string | undefined => {
  const code = stringField(value, 'code');
  if (code === undefined || !code.startsWith('X_')) return undefined;
  // A branded error is one by construction; a plain object has to show all three fields, which is
  // what a `{ code, cause, fix }` literal in a test fixture already does.
  if (isUltimateError(value)) return code;
  const complete =
    stringField(value, 'cause') !== undefined && stringField(value, 'fix') !== undefined;
  return complete ? code : undefined;
};

/** Standard Schema is the validation contract, so every blessed schema exposes `~standard`. */
interface StandardSchema {
  readonly '~standard': {
    validate(value: unknown): { issues?: unknown } | Promise<{ issues?: unknown }>;
  };
}

const isStandardSchema = (value: unknown): value is StandardSchema =>
  isRecord(value) && isRecord(value['~standard']);

/**
 * The receiver check, SYNCHRONOUS and separate from the work — measured against Bun 1.4.0: a
 * matcher declared `async` has any error it throws replaced by bun's own `Matcher \`x\` returned a
 * promise that rejected`, so the code, the cause and the fix are all gone by the time a reader sees
 * it. `X_TEST_SCHEMA_EXPECTED` and `X_TEST_JOB_EXPECTED` were declared, registered and titled, and
 * no caller could ever observe either (`matcher-receiver.test.ts`). The guard runs before the
 * matcher returns a promise; the work happens inside it.
 */
function assertStandardSchema(schema: unknown): StandardSchema {
  if (!isStandardSchema(schema)) throw new TestSchemaExpectedError();
  return schema;
}

/** The same rule for a job declaration. `recordSteps` is public, so it keeps its own check too. */
function assertJobDeclaration(job: unknown): JobLike {
  if (!isJob(job)) throw new TestJobExpectedError();
  return job;
}

async function hasIssues(schema: unknown, input: unknown): Promise<boolean> {
  if (!isStandardSchema(schema)) {
    throw new TestSchemaExpectedError();
  }
  const result = await schema['~standard'].validate(input);
  const issues = result.issues;
  return Array.isArray(issues) ? issues.length > 0 : issues !== undefined;
}

interface PolicyLike {
  evaluate(context: Readonly<Record<string, unknown>>): boolean | Promise<boolean>;
}

/** A `Policy` from @ultimat3/policy. It decides through `run()`; there is no `evaluate()` on it. */
interface RunnablePolicy {
  run(args: Readonly<Record<string, unknown>>): { readonly allowed: boolean };
}

const isPolicy = (value: unknown): value is PolicyLike =>
  isRecord(value) && typeof value['evaluate'] === 'function';

const isRunnablePolicy = (value: unknown): value is RunnablePolicy =>
  isRecord(value) && typeof value['run'] === 'function';

/**
 * `undefined` means "not a policy at all", which is a different failure from a denial.
 * `row` is defaulted the way `evaluate()` in @ultimat3/policy defaults it, so a test about a
 * rule that decides on input alone does not have to write `row: null` for the predicate to see
 * the field — and a row-level test still passes its own `row` and wins, because it comes second.
 */
async function decide(
  policy: unknown,
  context: Readonly<Record<string, unknown>>,
): Promise<boolean | undefined> {
  if (isRunnablePolicy(policy)) return policy.run({ row: null, ...context }).allowed;
  if (isPolicy(policy)) return policy.evaluate(context);
  return undefined;
}

interface JobLike {
  run(context: {
    input: unknown;
    step: StepRecorder;
    ctx: Record<string, unknown>;
  }): Promise<unknown>;
}

interface StepRecorder {
  run<T>(name: string, body: () => T | Promise<T>): Promise<T>;
  sleep(duration: string): Promise<void>;
}

const isJob = (value: unknown): value is JobLike =>
  isRecord(value) && typeof value['run'] === 'function';

/** Runs the job with a recording step API, so the assertion is on the sequence, not the effects. */
export async function recordSteps(job: unknown, input: unknown = {}): Promise<readonly string[]> {
  if (!isJob(job)) throw new TestJobExpectedError();
  const names: string[] = [];
  const step: StepRecorder = {
    run: async (name, body) => {
      names.push(name);
      return body();
    },
    sleep: async () => undefined,
  };
  await job.run({ input, step, ctx: {} });
  return names;
}

const result = (pass: boolean, message: string): MatcherResult => ({
  pass,
  message: () => message,
});

const isOpenApiLike = (value: unknown): value is OpenApiLike =>
  isRecord(value) &&
  Array.isArray(value['operations']) &&
  value['operations'].every(
    (entry) => typeof (entry as OpenApiLike['operations'][number] | null)?.operationId === 'string',
  );

/**
 * The two breaking changes this matcher can see from the shape `OpenApiLike` declares: an
 * operation that disappeared, and a parameter a surviving operation newly requires — the second
 * breaks every caller already omitting it, and comparing operation ids alone let it through while
 * a suite naming this matcher read as covered.
 *
 * Deliberately NOT a full OpenAPI diff. Response status codes, response schemas and parameter
 * TYPES are not on `OpenApiLike` and are not compared; the message says what did break rather than
 * claiming the contract is otherwise unchanged. `x verify`'s `contract-diff` step is the whole
 * answer, against the committed manifest.
 */
function breakingChanges(before: OpenApiLike, after: OpenApiLike): readonly string[] {
  const current = new Map(after.operations.map((operation) => [operation.operationId, operation]));
  const broke: string[] = [];
  for (const operation of before.operations) {
    const now = current.get(operation.operationId);
    if (now === undefined) {
      broke.push(`removed operation ${operation.operationId}`);
      continue;
    }
    // Only additions: dropping a requirement widens what the API accepts, which no caller notices.
    const wasRequired = new Set(operation.required ?? []);
    const added = (now.required ?? []).filter((name) => !wasRequired.has(name));
    if (added.length > 0) {
      broke.push(`${operation.operationId} newly requires ${added.join(', ')}`);
    }
  }
  return broke;
}

/**
 * Typed from the declaration rather than inferred from this literal, which is what makes the two
 * halves one thing: a matcher on `UltimateMatchers` with no entry here fails to compile, an entry
 * here that nothing declares is an excess property, and an argument list that drifts from the
 * declared one is a type error at the key that drifted. Inferred — `expect.extend({ … })` — none
 * of the three is visible, and a declared-but-unimplemented matcher fails at runtime in whichever
 * test calls it first.
 */
/**
 * What `expect.extend` binds `this` to. Bun supplies `isNot`, and it is the only member any matcher
 * here reads — measured, because the shape is not in bun's published types and a matcher that
 * guessed would silently wait for the wrong thing under `.not`.
 */
interface MatcherContext {
  readonly isNot: boolean;
}

const implementations: ExpectExtendMatchers<UltimateMatchers<unknown>> = {
  // NOT `async`, deliberately — see `assertVisibilityProbe`. A matcher declared `async` has any
  // error it throws replaced by bun's own "returned a promise that rejected", which is how the
  // three matchers below it lost their codes. The guard runs synchronously; the wait is the
  // promise this returns.
  toBeVisible(received: unknown, options?: VisibleOptions) {
    const probe = assertVisibilityProbe(received);
    // `this` and not a parameter: the direction is bun's to tell us, and `.not` has to change what
    // this WAITS for, not just how the answer is read.
    const context = this as unknown as MatcherContext;
    return visibilityResult(probe, context.isNot === true, options);
  },

  toBeUltimateError(received: unknown, code?: string) {
    const actual = codeOf(received);
    if (actual === undefined) {
      return result(
        false,
        `expected an UltimateError (an X_ code with a cause and a fix), received ${describeValue(received)}`,
      );
    }
    if (code === undefined) return result(true, `expected not to be an UltimateError`);
    return result(actual === code, `expected error code ${code}, received ${actual}`);
  },

  async toDenyPolicy(received: unknown, context: Readonly<Record<string, unknown>>) {
    const allowed = await decide(received, context);
    if (allowed === undefined) {
      return result(
        false,
        'expected a policy — an object with run() (@ultimat3/policy) or evaluate()',
      );
    }
    return result(!allowed, `expected the policy to deny ${JSON.stringify(context)}`);
  },

  // Not `async` — see `assertStandardSchema`. The guard is the synchronous prologue; the wait is
  // the promise this returns.
  toEmitSteps(received: unknown, expected: readonly string[]) {
    const job = assertJobDeclaration(received);
    return recordSteps(job).then((names) =>
      result(
        JSON.stringify(names) === JSON.stringify(expected),
        `expected steps ${expected.join(' -> ')}, ran ${names.join(' -> ')}`,
      ),
    );
  },

  toMatchOpenApi(received: unknown, committed: OpenApiLike) {
    if (!isOpenApiLike(received)) {
      return result(
        false,
        'expected an OpenAPI document — an object with operations: [{ operationId, required? }]',
      );
    }
    const broke = breakingChanges(committed, received);
    return result(
      broke.length === 0,
      `contract broke: ${broke.join('; ')} — bump the package version or restore the old shape`,
    );
  },

  toBeWithinBudget(received: unknown, limit: number) {
    if (typeof received !== 'number') {
      return result(
        false,
        `expected a number to compare against the budget, got ${typeof received}`,
      );
    }
    return result(received <= limit, `expected ${received} to be within the budget of ${limit}`);
  },

  toRejectInput(received: unknown, input: unknown) {
    const schema = assertStandardSchema(received);
    return hasIssues(schema, input).then((rejected) =>
      result(rejected, `expected the schema to reject ${JSON.stringify(input)}`),
    );
  },

  toAcceptInput(received: unknown, input: unknown) {
    const schema = assertStandardSchema(received);
    return hasIssues(schema, input).then((rejected) =>
      result(!rejected, `expected the schema to accept ${JSON.stringify(input)}`),
    );
  },
};

expect.extend(implementations);

/** Imported for its side effect by the preload; exported so a test can be explicit about it. */
export const matchersInstalled = true;

// Custom expectations. Each one exists because the assertion it replaces was being written by
// hand, differently, in every test — and a hand-written version of "did this policy deny?" is how
// a test ends up asserting on the wrong branch.

import { expect } from 'bun:test';
import type { OpenApiLike } from './test-types';

export interface MatcherResult {
  readonly pass: boolean;
  message(): string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const codeOf = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const code = value['code'];
  return typeof code === 'string' ? code : undefined;
};

/** Standard Schema is the validation contract, so every blessed schema exposes `~standard`. */
interface StandardSchema {
  readonly '~standard': {
    validate(value: unknown): { issues?: unknown } | Promise<{ issues?: unknown }>;
  };
}

const isStandardSchema = (value: unknown): value is StandardSchema =>
  isRecord(value) && isRecord(value['~standard']);

async function hasIssues(schema: unknown, input: unknown): Promise<boolean> {
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      'toRejectInput expects a Standard Schema (ArkType `t`) — pass action.input, not the action',
    );
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
  if (!isJob(job)) throw new TypeError('toEmitSteps expects a job declaration');
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

expect.extend({
  toBeUltimateError(received: unknown, code?: string) {
    const actual = codeOf(received);
    if (actual === undefined) {
      return result(false, `expected an UltimateError, received ${typeof received}`);
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

  async toEmitSteps(received: unknown, expected: readonly string[]) {
    const names = await recordSteps(received);
    return result(
      JSON.stringify(names) === JSON.stringify(expected),
      `expected steps ${expected.join(' -> ')}, ran ${names.join(' -> ')}`,
    );
  },

  toMatchOpenApi(received: unknown, committed: OpenApiLike) {
    const current = received as OpenApiLike;
    const before = committed.operations.map((operation) => operation.operationId).sort();
    const after = current.operations.map((operation) => operation.operationId).sort();
    const removed = before.filter((id) => !after.includes(id));
    return result(
      removed.length === 0,
      `contract removed operation(s): ${removed.join(', ')} — bump the package version or restore them`,
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

  async toRejectInput(received: unknown, input: unknown) {
    const rejected = await hasIssues(received, input);
    return result(rejected, `expected the schema to reject ${JSON.stringify(input)}`);
  },

  async toAcceptInput(received: unknown, input: unknown) {
    const rejected = await hasIssues(received, input);
    return result(!rejected, `expected the schema to accept ${JSON.stringify(input)}`);
  },
});

declare module 'bun:test' {
  interface Matchers<T> {
    toBeUltimateError(code?: string): T;
    toDenyPolicy(context: Readonly<Record<string, unknown>>): Promise<T>;
    toEmitSteps(steps: readonly string[]): Promise<T>;
    toMatchOpenApi(committed: OpenApiLike): T;
    toBeWithinBudget(limit: number): T;
    toRejectInput(input: unknown): Promise<T>;
    toAcceptInput(input: unknown): Promise<T>;
  }
}

/** Imported for its side effect by the preload; exported so a test can be explicit about it. */
export const matchersInstalled = true;

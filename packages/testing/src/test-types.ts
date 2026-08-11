// The six first-class test types. `x verify` selects a suite by FILENAME — `*.job.test.ts`, and
// so on — so these helpers only prefix the reported name with its type, which is what makes a
// failure line say which of the six steps it belongs to. See packages/cli/src/verify-tests.ts.

import { test } from 'bun:test';
import { TestEvalThresholdError } from './errors';

export const TEST_TYPES = ['unit', 'contract', 'live', 'job', 'e2e', 'eval'] as const;

export type TestType = (typeof TEST_TYPES)[number];

export const SEPARATOR = ' · ';

export const testName = (type: TestType, name: string): string => `${type}${SEPARATOR}${name}`;

export type TestBody = () => void | Promise<void>;

/** Pure logic: no database, no clock, no network. The cheapest test that can fail for real. */
export const unitTest = (name: string, body: TestBody): void => {
  test(testName('unit', name), body);
};

/** The published surface: OpenAPI diff against the committed spec, MCP exposure, error codes. */
export const contractTest = (name: string, body: TestBody): void => {
  test(testName('contract', name), body);
};

/** Live queries: assert exactly what each subscriber receives, snapshot then incremental patch. */
export const liveTest = (name: string, body: TestBody): void => {
  test(testName('live', name), body);
};

/** Jobs: step sequence, retries, idempotency. Never wall-clock sleeps — advance the frozen clock. */
export const jobTest = (name: string, body: TestBody): void => {
  test(testName('job', name), body);
};

/** One element selection, resolved when it is used rather than when it is built. */
export interface LocatorLike {
  count(): Promise<number>;
  click(): Promise<void>;
  first(): LocatorLike;
  isVisible(): Promise<boolean>;
}

/**
 * The browser surface an e2e test drives. Every member is one the reference app's e2e suite
 * already calls — this is the observed contract, not a wish list, and the driver that implements
 * it (a browser, at milestone 11) is the only thing that may add to it.
 */
export interface PageLike {
  goto(url: string): Promise<unknown>;
  /** The first flush of a streamed response — the shell, before the holes resolve. */
  gotoStreamed(url: string): Promise<{ readonly html: string }>;
  reload(): Promise<unknown>;
  /** Resolves once the service worker controls the page, so the offline assertions are not racy. */
  waitForServiceWorker(): Promise<void>;
  title(): Promise<string>;
  content(): Promise<string>;
  url(): string;
  evaluate<T>(fn: () => T): Promise<T>;
  locator(selector: string): LocatorLike;
  getByRole(
    role: string,
    options?: { readonly name?: string; readonly level?: number },
  ): LocatorLike;
  getByText(text: string): LocatorLike;
}

export interface E2eFixtures {
  readonly page: PageLike;
  /** Drop the network so the service worker has to answer. */
  offline(): Promise<void>;
  online(): Promise<void>;
  /** Publish a new build id so the SW update path runs. */
  update(): Promise<void>;
}

export type E2eBody = (fixtures: E2eFixtures) => Promise<void>;

let e2eDriver: ((name: string, body: E2eBody) => void) | undefined;

/**
 * Register the Playwright-backed driver. The e2e package wires this up; without it e2e tests are
 * skipped loudly rather than failing on a missing browser, and `x verify` reports the step as
 * skipped rather than green.
 */
export function useE2eDriver(driver: (name: string, body: E2eBody) => void): void {
  e2eDriver = driver;
}

export const e2eTest = (name: string, body: E2eBody): void => {
  if (e2eDriver === undefined) {
    test.skip(
      testName('e2e', `${name} (no browser driver: x build --target static && x e2e)`),
      () => undefined,
    );
    return;
  }
  e2eDriver(testName('e2e', name), body);
};

export interface EvalCase<TInput, TOutput> {
  readonly name: string;
  readonly input: TInput;
  /** 0..1. Below the threshold fails the test. */
  score(output: TOutput): number | Promise<number>;
}

export interface EvalOptions<TInput, TOutput> {
  readonly threshold: number;
  readonly cases: readonly EvalCase<TInput, TOutput>[];
  run(input: TInput): Promise<TOutput>;
}

/**
 * LLM output scoring with a threshold. Deterministic by construction: the model call goes through
 * the sealed network, so an eval either uses a recorded response or declares its allowlist.
 */
export function evalTest<TInput, TOutput>(
  name: string,
  options: EvalOptions<TInput, TOutput>,
): void {
  test(testName('eval', name), async () => {
    const scores: { readonly name: string; readonly score: number }[] = [];
    for (const testCase of options.cases) {
      const output = await options.run(testCase.input);
      scores.push({ name: testCase.name, score: await testCase.score(output) });
    }
    const failures = scores.filter((entry) => entry.score < options.threshold);
    if (failures.length > 0) {
      const detail = failures.map((entry) => `${entry.name}=${entry.score.toFixed(2)}`).join(', ');
      throw new TestEvalThresholdError({ name, threshold: options.threshold, detail });
    }
  });
}

export interface OpenApiOperationLike {
  readonly operationId: string;
  readonly required?: readonly string[];
}

export interface OpenApiLike {
  readonly operations: readonly OpenApiOperationLike[];
}

/**
 * Projection 6: the tests. `x g action` emits these three assertions for every
 * new action, so an action that skips validation, skips authz, or never reaches
 * the spec fails CI on the day it is written.
 */

import type { Ctx } from '@ultimat3/core';
import { createContext, isUltimateError, logger, renderFixShellArg } from '@ultimat3/core';
import type { AnyAction } from './action';
import { ActionDeniedError, ContractDriftError } from './errors';
import { toOpenApiOperation } from './http';
import { servedActionRoute } from './http-path';
import { actionName, invoke } from './invoke';
import { buildOpenApi } from './openapi';
import { listActions } from './registry';
import { describeSampleGap, sampleGaps, sampleInput } from './sample-input';
import { isJsonObject } from './stable';
import { validateInput } from './validate';

export interface ContractTest {
  readonly name: string;
  run(): Promise<void>;
}

export interface ContractTestOptions {
  /** Value the input schema must reject. `null` fails every object schema. */
  readonly garbage?: unknown;
  /**
   * Input for the policy assertion. Omitted means one synthesized from `input:` itself — pass it
   * when the schema carries a `pattern` (named for you, before the invocation, by
   * `assertSampleable`), a provider refinement the IR does not carry, or a `row:` loader that
   * needs an id which resolves.
   */
  readonly input?: unknown;
  readonly ctx?: Ctx;
}

/** A context whose actor is core's anonymous actor — what a signed-out caller has. */
export function anonymousCtx(): Ctx {
  return createContext({});
}

export function contractTestsFor(
  target: AnyAction,
  options: ContractTestOptions = {},
): readonly ContractTest[] {
  const name = actionName(target);
  const garbage = 'garbage' in options ? options.garbage : null;
  const ctx = options.ctx ?? anonymousCtx();

  return [
    {
      name: `${name}: input schema rejects garbage`,
      // The action's own parser — the one `invoke` runs — and never `invoke` itself: the policy's
      // actor half is decided BEFORE the parse, so an anonymous caller of a guarded action is
      // refused 401 without the schema ever seeing the garbage. The claim is about `input:`.
      run: async () => {
        await expectThrow(
          () => validateInput(target.input, garbage, name),
          'X_INPUT_INVALID',
          `${name} accepted the value this assertion sent as garbage`,
          `tighten \`input:\` in the ${name} definition`,
          { action: name, garbage },
        );
      },
    },
    {
      name: `${name}: policy denies an anonymous actor`,
      run: async () => {
        if ('input' in options) {
          await expectDenied(target, name, options.input, ctx);
          return;
        }
        assertSampleable(target, name);
        await expectDenied(target, name, sampleInput(target.input), ctx);
      },
    },
    {
      name: `${name}: OpenAPI document contains its operation`,
      run: async () => assertDocumented(target, name),
    },
  ];
}

/**
 * Against the document the APP publishes — the whole registry, plus this action when a test drives
 * a `.named()` twin nothing seated — never one built from this action alone: that one holds its
 * own path by construction, so the assertion could not fail. What can go wrong is in the rest of
 * the registry: a second action deriving the same route, whose operation is the one published.
 */
function assertDocumented(target: AnyAction, name: string): void {
  const seated = listActions();
  const actions = seated.some((other) => other.name === name) ? seated : [...seated, target];
  const { path } = servedActionRoute(name);
  const published = buildOpenApi({ actions }).paths[path];
  const owner = operationIdAt(published);
  if (owner === toOpenApiOperation(target).operationId) return;
  throw documentedDrift(path, owner, name);
}

/**
 * The refusal when the published document does not name this action at its route. `name` is
 * whatever `.named()` was handed — nothing validates its alphabet — so it is screened where it
 * enters the `x actions describe` command (security audit of plan 101 sweep 1c).
 */
export function documentedDrift(
  path: string,
  owner: string | undefined,
  name: string,
): ContractDriftError {
  return new ContractDriftError(
    owner === undefined
      ? `OpenAPI document has no entry for ${path}`
      : `OpenAPI document serves ${path} as ${owner}, so ${name} is not in the published contract`,
    owner === undefined
      ? 'x verify --json   # the contract suite is a step of it'
      : `x actions describe ${renderFixShellArg(name, '<action>')} --json   # then rename it, or pin its own route with http: { path } in the ${name} definition`,
  );
}

/** `paths[path].post.operationId`, read off a value typed `unknown` — narrowed, never cast. */
function operationIdAt(entry: unknown): string | undefined {
  if (!isJsonObject(entry) || !isJsonObject(entry['post'])) return undefined;
  const id = entry['post']['operationId'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * A `pattern` cannot be inverted, so the framework cannot build a payload for
 * `t.string.pattern(...)` — but the pattern IS in the IR, so it knows that BEFORE it invokes.
 * Reporting it here rather than letting `X_INPUT_INVALID` surface out of the action's own parse
 * is the difference between an instruction and a misattribution: the action is correct, `input:`
 * is correct, and the only thing that can supply the value is the author. The `fix:` is therefore
 * the exact call to paste, not an edit to the declaration.
 */
function assertSampleable(target: AnyAction, name: string): void {
  const gaps = sampleGaps(target.input);
  if (gaps.length === 0) return;
  const described = gaps.map((path) => describeSampleGap(target.input, path)).join(', ');
  throw new ContractDriftError(
    `${name}: no value can be synthesized for ${described}, so the denial would be unproven`,
    `contractTestsFor(${name}, { input: { … } })   # x actions describe ${name} --json prints the schema`,
  );
}

/**
 * The generated policy test. Emitted as source (not executed here) because the
 * app owns which actors it considers privileged.
 */
export function policyTestStubFor(target: AnyAction): string {
  const name = actionName(target);
  return `import { contractTestsFor } from '@ultimat3/action';
import { ${name} } from './actions';

// Fill in: arrange a foreign actor, expect the policy to deny.
// The contract tests below are framework-generated and always included. Pass
// \`{ input }\` if the synthesized one cannot satisfy this action's schema or row loader.
for (const contract of contractTestsFor(${name})) {
  test(contract.name, async () => {
    await contract.run();
  });
}
`;
}

/**
 * The assertion the second test is named for, and the reason it refuses to accept just any
 * thrown error: this used to pass on ANY `UltimateError`, and the input it sent was `{}` —
 * which fails `input:` for every action with a required field, so `X_INPUT_INVALID` was
 * thrown before the policy ran and the authz claim was never tested at all.
 *
 * `ActionDeniedError` is the one outcome that means the policy decided. It is asserted as a
 * class rather than as `X_FORBIDDEN`, because it re-uses the policy decision's own code and
 * the blessed `can()` answers a null actor with `X_UNAUTHENTICATED` — pinning one code would
 * fail every action that authors its policy the way the framework tells it to.
 */
async function expectDenied(
  target: AnyAction,
  name: string,
  input: unknown,
  ctx: Ctx,
): Promise<void> {
  try {
    await invoke(target, input, { ctx, surface: 'http' });
  } catch (error) {
    // A handler's own bug keeps its stack: wrapping a TypeError from a `row:` loader in a
    // drift error would hide the line that threw behind a fix that does not apply.
    if (!isUltimateError(error)) throw error;
    if (error instanceof ActionDeniedError) return;
    // `invoke` runs the policy's actor half → parse input → row → policy → handle → parse
    // output, and every stage lands here identically. Only `X_INPUT_INVALID` is attributable: it
    // is what `validateInput` raises before `guard()` is reached (for a policy whose actor half
    // could not decide), and `input:` is the knob that answers it. Any other
    // code — `X_TENANCY_UNSCOPED` from a `row:` loader, `X_DB_CONFLICT` from a handler,
    // `X_OUTPUT_INVALID` from the parse after it — keeps its own code and its own fix rather
    // than being retold as an input problem with a fix that changes nothing.
    if (error.code !== 'X_INPUT_INVALID') throw error;
    throw new ContractDriftError(
      `${name} failed with ${error.code} before its policy decided, so the denial is unproven`,
      `pass \`input:\` to contractTestsFor(${name}) — x actions describe ${name} --json prints the schema`,
    );
  }
  throw new ContractDriftError(
    `${name} ran for an actor of null`,
    `make the ${name} policy require an authenticated actor`,
  );
}

/**
 * `fields` and not a rendered value: `garbage` is the caller's, typed `unknown`, and it was
 * interpolated into `cause` with `JSON.stringify` — which throws on a circular object and on a
 * `bigint`. That throw happened on the way INTO this helper, so the assertion never ran and the
 * failure reported was the stringifier's, not the schema's. The logger takes the value as a field
 * and shapes it itself, the way `cache-gate.ts` and `idempotency.ts` hand it their `error`.
 */
async function expectThrow(
  run: () => Promise<unknown>,
  code: string,
  cause: string,
  fix: string,
  fields: Readonly<Record<string, unknown>>,
): Promise<void> {
  const report = (): void => logger.error('action.contract.assertion-failed', { ...fields, code });
  try {
    await run();
  } catch (error) {
    if (!isUltimateError(error)) throw error;
    if (error.code === code) return;
    report();
    throw new ContractDriftError(`${cause} (got ${error.code}, expected ${code})`, fix);
  }
  report();
  throw new ContractDriftError(cause, fix);
}

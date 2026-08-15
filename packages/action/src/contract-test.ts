/**
 * Projection 6: the tests. `x g action` emits these three assertions for every
 * new action, so an action that skips validation, skips authz, or never reaches
 * the spec fails CI on the day it is written.
 */

import type { Ctx } from '@ultimat3/core';
import { createContext, isUltimateError } from '@ultimat3/core';
import type { AnyAction } from './action';
import { ActionDeniedError, ContractDriftError } from './errors';
import { actionName, invoke } from './invoke';
import { derivePath } from './naming';
import { buildOpenApi } from './openapi';
import { sampleInput } from './sample-input';

export interface ContractTest {
  readonly name: string;
  run(): Promise<void>;
}

export interface ContractTestOptions {
  /** Value the input schema must reject. `null` fails every object schema. */
  readonly garbage?: unknown;
  /**
   * Input for the policy assertion. Omitted means one synthesized from `input:` itself — pass
   * it when the schema carries a constraint the IR does not (a bare `pattern`, a provider
   * refinement), or when the action's `row:` loader needs an id that resolves.
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
      run: async () => {
        await expectThrow(
          () => invoke(target, garbage, { ctx, surface: 'http' }),
          'X_INPUT_INVALID',
          `${name} accepted ${JSON.stringify(garbage) ?? 'undefined'} as input`,
          `tighten \`input:\` in the ${name} definition`,
        );
      },
    },
    {
      name: `${name}: policy denies an anonymous actor`,
      run: async () => {
        const input = 'input' in options ? options.input : sampleInput(target.input);
        await expectDenied(target, name, input, ctx);
      },
    },
    {
      name: `${name}: OpenAPI document contains its operation`,
      run: async () => {
        const document = buildOpenApi({ actions: [target] });
        const path = derivePath(name).path;
        if (document.paths[path] === undefined) {
          throw new ContractDriftError(
            `OpenAPI document has no entry for ${path}`,
            'x verify --contract',
          );
        }
      },
    },
  ];
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
    // `invoke` runs parse input → row → policy → handle → parse output, and every stage lands
    // here identically. Only `X_INPUT_INVALID` is attributable: it is what `validateInput`
    // raises before `guard()` is reached, and `input:` is the knob that answers it. Any other
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

async function expectThrow(
  run: () => Promise<unknown>,
  code: string,
  cause: string,
  fix: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!isUltimateError(error)) throw error;
    if (error.code === code) return;
    // `X_AUDIT_SINK_MISSING` is the one refusal `invoke` raises BEFORE the input parse, so
    // "the schema accepted garbage" is a false statement about it and `input:` is not what
    // answers it. It keeps its own code and its own runnable fix — the same rule `expectDenied`
    // follows for every code it cannot attribute to `input:`.
    if (error.code === 'X_AUDIT_SINK_MISSING') throw error;
    throw new ContractDriftError(`${cause} (got ${error.code}, expected ${code})`, fix);
  }
  throw new ContractDriftError(cause, fix);
}

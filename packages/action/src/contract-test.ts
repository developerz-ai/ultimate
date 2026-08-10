/**
 * Projection 6: the tests. `x g action` emits these three assertions for every
 * new action, so an action that skips validation, skips authz, or never reaches
 * the spec fails CI on the day it is written.
 */

import type { Ctx } from '@ultimat3/core';
import { createContext, isUltimateError } from '@ultimat3/core';
import type { AnyAction } from './action';
import { ContractDriftError } from './errors';
import { actionName, invoke } from './invoke';
import { derivePath } from './naming';
import { buildOpenApi } from './openapi';

export interface ContractTest {
  readonly name: string;
  run(): Promise<void>;
}

export interface ContractTestOptions {
  /** Value the input schema must reject. `null` fails every object schema. */
  readonly garbage?: unknown;
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
        await expectThrow(
          () => invoke(target, emptyInput(), { ctx, surface: 'http' }),
          null,
          `${name} ran for an actor of null`,
          `make the ${name} policy require an authenticated actor`,
        );
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
// The contract tests below are framework-generated and always included.
for (const contract of contractTestsFor(${name})) {
  test(contract.name, async () => {
    await contract.run();
  });
}
`;
}

/** An input the schema may still reject — only the policy assertion depends on it. */
function emptyInput(): unknown {
  return {};
}

async function expectThrow(
  run: () => Promise<unknown>,
  code: string | null,
  cause: string,
  fix: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!isUltimateError(error)) throw error;
    if (code === null || error.code === code) return;
    throw new ContractDriftError(`${cause} (got ${error.code}, expected ${code})`, fix);
  }
  throw new ContractDriftError(cause, fix);
}

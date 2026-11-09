// Single responsibility: `stub(primitive)` — the one test double for an action, an `llm()` (which
// IS an action), a query or a job. Its body answers from a script; everything around the body stays the
// real path, and the stub is put back after the test that made it (`test-scope.ts`).

import type { Action } from '@ultimat3/action';
import type { JobHandle } from '@ultimat3/jobs';
import { isJobHandle } from '@ultimat3/jobs';
import type { Query } from '@ultimat3/query';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { TestStubTargetUnsupportedError } from './stub-errors';
import { stubJobBody } from './stub-job';
import type { Stub, StubWiring } from './stub-script';
import { stubScript } from './stub-script';
import type { Undo } from './test-scope';
import { scopedInstall } from './test-scope';

const isCallableObject = (value: unknown): value is object =>
  (typeof value === 'object' || typeof value === 'function') && value !== null;

async function install(
  target: unknown,
  wiring: (input: StandardSchemaV1) => StubWiring<unknown, unknown>,
): Promise<{ readonly stub: Stub<unknown, unknown>; readonly undo: Undo }> {
  if (isJobHandle(target)) {
    const wired = wiring(target.input);
    return { stub: wired.stub, undo: stubJobBody(target, wired) };
  }
  // Loaded only now: the barrel stays action-free for a tier-0 test importing it for `expect`.
  const { isAction } = await import('@ultimat3/action');
  if (isAction(target)) {
    const { stubActionHandler } = await import('./stub-action');
    const wired = wiring(target.input);
    return { stub: wired.stub, undo: await stubActionHandler(target, wired) };
  }
  const { isQuery } = await import('@ultimat3/query');
  if (isQuery(target)) {
    const { stubQueryRows } = await import('./stub-query');
    const wired = wiring(target.input) as StubWiring<unknown, readonly object[]>;
    return { stub: wired.stub, undo: await stubQueryRows(target, wired) };
  }
  throw new TestStubTargetUnsupportedError(target);
}

/**
 * Replace `target`'s body for this test — inside a test, until it ends; outside one (`beforeAll`,
 * module scope), until its file ends. `returns(...)` / `throws(error)` script the answers;
 * `expect(stubbed).toHaveBeenCalledWith(input)` reads the calls.
 *
 * ```ts
 * const charged = await stub(chargeCard);
 * charged.returns({ chargeId: 'ch_1' });
 * await checkout({ cartId });                    // the real action, calling the stubbed one
 * expect(charged).toHaveBeenCalledWith({ cartId, amount });
 * ```
 */
export function stub<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  target: Action<TInput, TOutput>,
): Promise<Stub<InferOutput<TInput>, InferOutput<TOutput>>>;
export function stub<TInput extends StandardSchemaV1, TRow extends object, TSingle extends boolean>(
  target: Query<TInput, TRow, TSingle>,
): Promise<Stub<InferOutput<TInput>, readonly TRow[]>>;
export function stub<I>(target: JobHandle<I>): Promise<Stub<I, unknown>>;
export async function stub(target: unknown): Promise<Stub<unknown, unknown>> {
  if (!isCallableObject(target)) throw new TestStubTargetUnsupportedError(target);
  const name = (target as { readonly name?: unknown }).name;
  const label = typeof name === 'string' ? name : '';
  return scopedInstall(`stub(${label})`, async () => {
    // Stubs STACK on a target (`stub-stack.ts`): a second one answers over the first, and its undo
    // hands the first back — a file's stub survives a test's.
    const { stub: made, undo } = await install(target, (input) => stubScript(label, input));
    return { value: made, undo };
  });
}

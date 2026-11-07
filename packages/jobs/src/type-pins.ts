// Compile-time pins for what a step answers. Source, not a `.test.ts`, on purpose: `tsconfig.json`
// excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a claim written there can
// never fail. Nothing here is called — a regression is a build error (axiom 3).

import type { JsonValue } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import type { StepApi, StepOutput } from './steps';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

/** Exact, both ways; assignability alone cannot tell a `readonly` or an optional member apart. */
type Same<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

type UserId = string & { readonly __brand: 'UserId' };

interface Row {
  readonly id: UserId;
  readonly at: Date;
  readonly maybeAt: Date | null;
  nick?: string;
  gone: string | undefined;
  load(): void;
}

export type StepOutputPins = [
  // A `Date` read off a step result is a compile error at the read.
  Assert<Same<StepOutput<Date>, string>>,
  Assert<Same<StepOutput<{ toJSON(): { wire: true } }>, { wire: true }>>,
  // A brand survives: it is a string on the wire and in the type.
  Assert<Same<StepOutput<UserId>, UserId>>,
  // `undefined` at the top is the `null` the store holds.
  Assert<Same<StepOutput<string | undefined>, string | null>>,
  Assert<Same<StepOutput<undefined>, null>>,
  // A readonly array stays one, and an element undefined is `null`, as `JSON.stringify` writes it.
  Assert<Same<StepOutput<readonly Date[]>, readonly string[]>>,
  Assert<Same<StepOutput<(number | undefined)[]>, (number | null)[]>>,
  Assert<Same<StepOutput<readonly [Date, number]>, readonly [string, number]>>,
  // `void` stays `void`: nobody reads it, and an `async () => {}` step must keep compiling.
  Assert<Same<StepOutput<void>, void>>,
  // `unknown` promises nothing and stays that way.
  Assert<Same<StepOutput<unknown>, unknown>>,
  Assert<Same<StepOutput<{ a: unknown }>, { a: unknown }>>,
  // Members: readonly and optional kept, a function dropped, a `T | undefined` one may be absent.
  Assert<
    Same<
      StepOutput<Row>,
      {
        readonly id: UserId;
        readonly at: string;
        readonly maybeAt: string | null;
        nick?: string;
        gone?: string;
      }
    >
  >,
  // A `Map` writes `{}`, and its `size` is not on the wire.
  Assert<Same<StepOutput<Map<string, number>>, Record<string, never>>>,
  Assert<Same<StepOutput<RegExp>, Record<string, never>>>,
  // `message`, `name` and `stack` are not own enumerable; only what a subclass adds is written.
  Assert<Same<keyof StepOutput<Error>, never>>,
  Assert<Same<StepOutput<Error & { readonly status: number }>, { readonly status: number }>>,
  // An object keyed by index, with no `length` on the wire.
  Assert<Same<StepOutput<Uint8Array>, Record<string, number>>>,
  // `bigint` never arrives: X_STEP_OUTPUT_UNSERIALIZABLE.
  Assert<Same<StepOutput<bigint>, never>>,
  // Already JSON comes back as itself, recursive type and all — it was TS2589 before 30.1.0.
  Assert<Same<StepOutput<JsonValue>, JsonValue>>,
  Assert<
    Same<
      StepOutput<{ readonly payload: JsonValue; readonly at: Date }>,
      { readonly payload: JsonValue; readonly at: string }
    >
  >,
];

const Approval = t.object({ amount: t.number });

/** Never called: the point is the types of what it reads. */
export async function waitForEventPins(step: StepApi): Promise<void> {
  const answer = await step.waitForEvent('approval', 'invoice.approved', { schema: Approval });
  const pinned: Assert<Same<typeof answer, { amount: number } | undefined>> = true;
  void pinned;

  // @ts-expect-error `schema` is required: a waiter's own type would be a cast, not a fact.
  await step.waitForEvent('approval', 'invoice.approved', { timeout: '1h' });
  // @ts-expect-error the options are required, because `schema` is.
  await step.waitForEvent('approval', 'invoice.approved');
  // @ts-expect-error `<T>` is gone: the schema is what decides the type.
  await step.waitForEvent<{ amount: number }>('approval', 'invoice.approved', { schema: Approval });

  const stamp = await step.run('stamp', () => new Date(0));
  // @ts-expect-error a `Date` is a string by the time a step answers it; `new Date(stamp)`.
  void stamp.getTime();
  const row = await step.run('load', () => Promise.resolve<{ id: string } | undefined>(undefined));
  const missed: Assert<Same<typeof row, { id: string } | null>> = true;
  void missed;
}

// Compile-time pins for the inference this package promises. Source, not a `.test.ts`, on purpose:
// `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a claim
// written there can never fail. Nothing here emits — a regression is a build error (axiom 3).

import type { JobHandle } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { inAppChannel } from './channel-in-app';
import { notifier } from './notifier';
import type { NotifyPayload } from './plan';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

/**
 * THE README'S DECLARATION, without an explicit type argument — the form every app writes and the
 * one the `typecheck` step cannot read out of a README fence.
 *
 * It is here because it did not compile. Before `NoInfer` landed on every field but `input`,
 * `Params` was inferred from all six at once and `deliver: [inAppChannel()]` — whose own default is
 * `unknown` — won, so `params.postId` below was a `TS18046: 'params' is of type 'unknown'`. The
 * schema is the one declaration of what the params are; this is what makes the inference agree.
 */
function readmeDeclaration() {
  return notifier({
    name: 'notify.type-pin',
    input: t.object({ postId: t.uuid, orgId: t.uuid, author: t.string }),
    tenant: (params) => params.orgId,
    key: (params) => `pin:${params.postId}`,
    recipients: ({ input }) => [{ id: input.author }],
    deliver: [{ channel: inAppChannel(), unless: ({ event }) => event.params.author === 'system' }],
  });
}

/**
 * Inside a function that is never CALLED, so this module registers nothing. `notifier()` builds a
 * `job()` and a job's name is claimed at declaration — a module-scope call here would put a
 * phantom `notify.type-pin` in every app's queue registry, which is the "built and never called"
 * defect in its most literal form.
 */
type Inferred = ReturnType<typeof readmeDeclaration>;

/** A notifier IS a `job`, so every worker path and every `x jobs` command reaches it unchanged. */
export type _NotifierIsAJobHandle = Assert<
  Inferred extends JobHandle<NotifyPayload<{ postId: string; orgId: string; author: string }>>
    ? true
    : false
>;

/** The payload nests `params`; a flattened one would collide with an app field called
 * `recipients`, which is the reason it is nested at all. */
export type _PayloadNestsParams = Assert<
  Parameters<Inferred['idempotencyKeyFor']>[0] extends { params: { postId: string } } ? true : false
>;

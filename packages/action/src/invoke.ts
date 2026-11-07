/**
 * The one invocation core: ask who is calling, spend the rate limit, parse input, evaluate
 * policy, draw the meter, run the handler, parse output. The declaration lives in this module's private store, so `handle` is
 * unreachable from anywhere else — HTTP, MCP, jobs and `.as()` hand `invoke` a
 * payload, and none of them can become a second execution path.
 *
 * `audit: true` wraps that path, it never forks it: `execute` is the same body either way, and
 * the audited branch only observes it. Wrapping rather than hooking is what lets a DENIED attempt
 * be recorded at all — `guardAction` throws before `handle`, so nothing an app writes around its own
 * handler could ever see one.
 */

import type { Ctx } from '@ultimat3/core';
import {
  actorOf,
  anonymousActor,
  ctxOf,
  failureCaptureActive,
  isUltimateError,
  REDACTED,
  recordFailureInput,
  runWithContext,
  tryUseContext,
  useContext,
  withChildContext,
  withFailureCapture,
  withSpan,
} from '@ultimat3/core';
import { statusFor } from '@ultimat3/http';
import { maskSensitive } from '@ultimat3/schema';
import type { AnyAction, AnyActionDef, InvokeOptions } from './action';
import type { AuditRecord } from './audit';
import {
  auditFailureFor,
  auditOutcomeFor,
  auditSettled,
  auditSinkFor,
  auditThrew,
} from './audit-gate';
import { bustAfterCommit } from './cache-gate';
import { judgedHandler } from './declared-errors';
import { ActionForeignError, ActionUnregisteredError } from './errors';
import { getIdempotencyStore, withIdempotency } from './idempotency';
import { idempotencyKeyFor } from './idempotency-key';
import { drawMeter } from './meter-gate';
import { guardAction, guardActionBeforeInput } from './policy-gate';
import { spendActionLimit, withCallerAddress, withJobFrame } from './rate-limit-gate';
import { parseActionInput, parsedOrNothing, validateOutput } from './validate';

/**
 * Private on purpose. `@ultimat3/action` exports no way to read this back, which
 * is what makes "the only way to reach `handle` is `invoke`" structural rather
 * than a rule someone has to remember.
 */
const DECLARATIONS = new WeakMap<object, AnyActionDef>();

/** Called once per built action, by `action()` and by every rename it produces. */
export function stashDef(target: object, def: AnyActionDef): void {
  DECLARATIONS.set(target, def);
}

/** True only for objects this package built — `isAction` leans on it. */
export function hasDef(target: object): boolean {
  return DECLARATIONS.has(target);
}

/** Internal read of the declaration. Never re-exported from `src/index.ts`. */
export function defOf(target: AnyAction): AnyActionDef {
  const def = DECLARATIONS.get(target);
  if (def === undefined) throw new ActionForeignError(target.name);
  return def;
}

/**
 * How many times each declaration's `handle` has started, keyed like `DECLARATIONS`. Read only by
 * `exercise.ts` — never re-exported — so "zero runs reached the handler" is countable without a
 * second execution path: a contract that never got past policy or parse is its own red.
 */
const HANDLER_REACHED = new WeakMap<AnyActionDef, number>();

/** Starts of `target`'s handler so far, across every surface. Off the barrel on purpose. */
export function handlerReached(target: AnyAction): number {
  return HANDLER_REACHED.get(defOf(target)) ?? 0;
}

/** Projections need a stable name; an unregistered action has none yet. */
export function actionName(target: AnyAction): string {
  if (target.name.length === 0) throw new ActionUnregisteredError();
  return target.name;
}

/**
 * Run an action. Surfaces differ only in the `surface` they pass, which selects
 * how a denial is rendered — never whether authz runs, never how input is parsed,
 * never whether the handler's return value is checked against `output`.
 */
export function invoke(
  target: AnyAction,
  raw: unknown,
  options: InvokeOptions = {},
): Promise<unknown> {
  // The address a surface handed over becomes the one every nested call inherits — an agent's
  // tool calls are keyed by the visitor who asked, not shared by every anonymous visitor.
  // A job run opens a fresh frame instead: no visitor's address follows work into the worker.
  return options.surface === 'job'
    ? withJobFrame(() => invokeAs(target, raw, options))
    : withCallerAddress(options.clientAddress, () => invokeAs(target, raw, options));
}

function invokeAs(target: AnyAction, raw: unknown, options: InvokeOptions): Promise<unknown> {
  if (options.actor === undefined) {
    // INSTALLED, never only handed over. An explicit `ctx` used to be passed to `core` and to
    // nothing else, so everything downstream that reads the ambient context — most importantly
    // `@ultimat3/entity`'s tenant guard, which derives from `tryUseContext()` and not from the ctx
    // it is given — saw either a different identity or none at all: policy decided about this
    // actor while a row's tenancy was decided about nobody. When `ctx` is absent this is
    // `runWithContext(useContext(), …)`, which is the context already installed — a no-op on every
    // path that worked before.
    const ctx = options.ctx ?? useContext();
    return runWithContext(ctx, () => core(target, raw, ctx, options));
  }

  // Impersonation keeps the surrounding context whole — services, clock, locale,
  // trace — and swaps only the actor. Policy models "nobody" as null; core models
  // it as the anonymous actor.
  const patch = { actor: options.actor ?? anonymousActor() };
  const run = (): Promise<unknown> => core(target, raw, useContext(), options);
  const base = options.ctx ?? tryUseContext();
  return base === undefined
    ? runWithContext(ctxOf(patch), run)
    : runWithContext(base, () => withChildContext(patch, run));
}

/**
 * What `execute` learns on the way through, for the audit record. Mutable and module-private:
 * the three facts a record needs that only exist partway down the one path, and reading them back
 * out is what keeps the audit branch from becoming a second one.
 */
interface InvokeTrace {
  input: unknown;
  idempotencyKey: string | null;
  replayed: boolean;
}

async function core(
  target: AnyAction,
  raw: unknown,
  ctx: Ctx,
  options: InvokeOptions,
): Promise<unknown> {
  const def = defOf(target);
  const name = actionName(target);
  const trace: InvokeTrace = { input: undefined, idempotencyKey: null, replayed: false };
  if (def.audit !== true) return execute(def, name, raw, ctx, options, trace);

  // Resolved before the input parse: an audited action nothing can record must refuse while it
  // has still made no change. Everything after this point has a committed write behind it.
  const sink = auditSinkFor(name);
  const draft = {
    // When the attempt began, from the context's clock — never `new Date()`.
    at: ctx.now(),
    name,
    primitive: 'action',
    // The brand `mutator()` stamps, read structurally — the same read `describeAction` makes,
    // and for the same reason: importing `isMutator` would point this module at the one that
    // imports it, for a check that needs the brand and not the predicate.
    mutator: (target as { readonly isMutator?: unknown }).isMutator === true,
    surface: options.surface ?? 'server',
    ctx,
  } as const;

  let value: unknown;
  try {
    value = await execute(def, name, raw, ctx, options, trace);
  } catch (error) {
    // A failed mutation is the record an auditor wants most, so the throw is recorded before it
    // is re-thrown — and `auditThrew` never replaces it, which is why this rethrow is
    // unconditional rather than inside an `else`.
    const record: AuditRecord = {
      ...draft,
      ...trace,
      outcome: auditOutcomeFor(error),
      failure: auditFailureFor(error),
    };
    await auditThrew(sink, record);
    throw error;
  }
  // Outside the `catch` above on purpose: an `X_AUDIT_SINK_FAILED` from here describes the
  // RECORD, not the attempt. Letting it fall into that branch wrote a second row claiming the
  // action failed, for a handler that had committed.
  await auditSettled(sink, { ...draft, ...trace, outcome: 'allowed', failure: null });
  return value;
}

/**
 * The span covers the WHOLE invocation, not just `handle`. Wrapping the handler alone reported
 * 40ms for an action whose p99 was 2s, because `def.row()` — the loader a row-level policy needs
 * — ran outside it, along with the input parse and `guardAction()`. The 1.96s was inside no span at
 * all, so the only reading available was "framework overhead" and the only fix was hand
 * instrumentation. One span, one extent, and the attributes that make it answerable.
 *
 * Attributes are chosen for bounded cardinality — surface, actor KIND, outcome, booleans — with
 * one exception: the namespaced idempotency key, which is the single fact that joins a retry to
 * the call it is retrying and is what a trace is for. It is never a metric label.
 */
async function execute(
  def: AnyActionDef,
  name: string,
  raw: unknown,
  ctx: Ctx,
  options: InvokeOptions,
  trace: InvokeTrace,
): Promise<unknown> {
  // A 5xx keeps a replayable bundle when `failureCapture` is on (`x repro`); off, `run` runs bare.
  return withFailureCapture('action', name, statusFor, () =>
    traced(def, name, raw, ctx, options, trace),
  );
}

async function traced(
  def: AnyActionDef,
  name: string,
  raw: unknown,
  ctx: Ctx,
  options: InvokeOptions,
  trace: InvokeTrace,
): Promise<unknown> {
  return withSpan(`action.${name}`, async (span) => {
    span.setAttributes({
      'ultimate.primitive': 'action',
      'ultimate.action': name,
      'ultimate.surface': options.surface ?? 'server',
      'ultimate.actor.kind': ctx.actor.kind,
      'ultimate.idempotent': def.idempotent === true,
    });
    try {
      const value = await perform(def, name, raw, ctx, options, trace);
      span.setAttributes({
        'ultimate.outcome': 'allowed',
        'ultimate.idempotency.replayed': trace.replayed,
      });
      if (trace.idempotencyKey !== null) {
        span.setAttribute('ultimate.idempotency.key', trace.idempotencyKey);
      }
      return value;
    } catch (error) {
      // The same two words the audit record uses, from the same function: a denial and a failure
      // are different questions, and a trace that called both "error" cannot separate them.
      span.setAttribute('ultimate.outcome', auditOutcomeFor(error));
      if (isUltimateError(error)) span.setAttribute('ultimate.error.code', error.code);
      throw error;
    }
  });
}

/** The invocation itself, unwrapped: gate, parse, load the row, guard, run, parse, bust. */
async function perform(
  def: AnyActionDef,
  name: string,
  raw: unknown,
  ctx: Ctx,
  options: InvokeOptions,
  trace: InvokeTrace,
): Promise<unknown> {
  const surface = options.surface ?? 'server';
  // Who is asking is decided before what they sent is read: a caller the policy refuses whatever
  // the input is gets 403/401 here, not a 400 whose issues describe this action's input schema.
  // Only the actor half runs — a predicate over `input` or `row` waits for `guardAction` below.
  try {
    guardActionBeforeInput(def.policy, { actor: actorOf(ctx), ctx, action: name }, surface);
  } catch (denial) {
    // The audit record still names what was attempted — the denial is already decided, so parsing
    // now tells the CALLER nothing, and an unparseable payload is a record with no input.
    if (def.audit === true) {
      trace.input = maskSensitive(def.input, await parsedOrNothing(def.input, raw), REDACTED);
    }
    throw denial;
  }
  // The ONE place a declared `rateLimit:` is spent, so every surface draws on the same bucket.
  // HERE — after the actor half (a refused caller learns that, not a 429), BEFORE the parse, the
  // row load and `guardAction`: spent later, a flood of invalid input (400) or row-denied calls (403)
  // was never refused, and every 429 had already paid for a row load.
  const spend = (): Promise<void> =>
    spendActionLimit(name, def.rateLimit, ctx, {
      surface,
      clientAddress: options.clientAddress,
      onRateLimit: options.onRateLimit,
    });
  const key = def.idempotent === true ? (options.idempotencyKey ?? null) : null;
  const store = key === null ? undefined : (options.store ?? getIdempotencyStore());
  // The namespaced key, not the caller's: the same key under two actions — or from two callers
  // — is two keys, and an audit row keyed on the raw header would collide across both. The
  // ACTOR comes from `ctx`, which `invoke` installed, so every surface scopes identically.
  if (key !== null) trace.idempotencyKey = idempotencyKeyFor(name, key, ctx.actor);
  // A replay is its stored answer and spends nothing — a 429 in its place told a client its
  // committed write had not happened. A key the store already holds is a replay (or a duplicate in
  // flight, answered 409); only a key it does not hold spends here. The peek can be stale both
  // ways, so `withIdempotency` meters a reservation it CREATED that this peek did not pay for.
  // The same peek serves the row rule below, so an action that needs neither makes no read here.
  const peeked =
    trace.idempotencyKey === null ||
    store === undefined ||
    (def.rateLimit === undefined && def.row === undefined)
      ? undefined
      : await store.get(trace.idempotencyKey);
  const spentEarly = def.rateLimit === undefined || peeked === undefined;
  if (spentEarly) await spend();

  const input = await parseActionInput(def.input, raw, name);
  if (failureCaptureActive()) recordFailureInput(maskSensitive(def.input, input, REDACTED));
  // The audit record's copy, `.sensitive()` fields masked by THIS action's own schema — never a
  // key table, so a `cardPan` flagged here changes nothing another action records or stores.
  if (def.audit === true) trace.input = maskSensitive(def.input, input, REDACTED);
  // The one place a row-level rule gets its row. Once per invocation, never per row:
  // that asymmetry is what lets the predicate stay synchronous, so a live query can
  // re-evaluate the same policy per subscriber without a query per change event. An
  // action with no loader hands the rule `null` — unchanged, and never a silent allow,
  // because a rule that reads `row` has to decide what `null` means.
  // The SAME `input` object reaches `def.row` here and `def.handle` below, by reference:
  // `transition()` keys what its rule read on it (`transition-observe.ts`, #702).
  const judgeRow = async (): Promise<void> => {
    // `row` and `handle` are the two places `errors:` judges a throw (`declared-errors.ts`).
    const load = def.row;
    const row =
      load === undefined
        ? null
        : ((await judgedHandler(def, name, () => load.call(def, { input, ctx }))) ?? null);
    guardAction(def.policy, { actor: actorOf(ctx), input, row, ctx, action: name }, surface);
  };
  // A finished record is this key's outcome, and the key is this actor's (`idempotency-key.ts`).
  // The row it decided about may be the row it deleted: a rule asked again judges `null`, and a
  // committed write answers its own retry with a refusal. So the loader and the rule wait, and
  // `withIdempotency` answers: the replay, or the conflict for another payload. Who is asking was
  // already decided, per call, by `guardActionBeforeInput` above: a revoked `can()` is refused
  // here too. In flight or absent, nothing has been decided yet, so the rule decides.
  const answered = def.row !== undefined && peeked !== undefined && peeked.status !== 'in-flight';
  if (!answered) await judgeRow();

  // Output parsing sits inside `run` so a replayed idempotent response is the parsed value too —
  // one shape on the wire, first call and every retry. No span of its own: `execute` above holds
  // the one that covers this invocation, and a second here would only re-time its tail.
  let started = false;
  const run = async (): Promise<unknown> => {
    started = true;
    HANDLER_REACHED.set(def, (HANDLER_REACHED.get(def) ?? 0) + 1);
    // Read here, not closed over: under a key this runs in `runToCompletion`'s scope, and a handler
    // passing the outer `ctx.signal` onward would fail its vendor call and settle a failure.
    const produced = await judgedHandler(def, name, () => def.handle({ input, ctx: useContext() }));
    return validateOutput(def.output, produced, name);
  };
  // The meter is drawn LAST before the handler, on every surface `surface: 'server'` included: a
  // call refused by the policy, the parse or the rate limit used none of the allowance. Under a key
  // it is drawn only for a reservation this call CREATED (`beforeRun`), so a replay — of a success
  // or of a settled failure — draws nothing, and a refusal releases the key for a retry next period.
  const metered = (): Promise<void> =>
    def.meter === undefined ? Promise.resolve() : drawMeter(name, def.meter, ctx);
  // The peek can be stale: a record that lapsed after it leaves this call a FRESH reservation, and
  // the handler must not run on a rule it skipped. `beforeRun` runs only for a created reservation,
  // and a refusal there releases it. Spend first, in the order a first call takes them.
  const beforeRun = async (): Promise<void> => {
    if (!spentEarly) await spend();
    if (answered) await judgeRow();
    await metered();
  };

  try {
    if (store === undefined || trace.idempotencyKey === null) {
      await metered();
      return await run();
    }
    const outcome = await withIdempotency(store, trace.idempotencyKey, input, run, {
      ...(spentEarly && !answered && def.meter === undefined ? {} : { beforeRun }),
    });
    if (outcome.replayed) options.onReplay?.();
    trace.replayed = outcome.replayed;
    // A replay is parsed like a first call. The memory store hands back the live value and the
    // postgres store `JSON.parse(JSON.stringify(v))` — a `Date` on the first call and a `string`
    // on every retry served from Postgres — so the output schema is the one answer to its shape.
    return outcome.replayed ? validateOutput(def.output, outcome.value, name) : outcome.value;
  } finally {
    // Only for a handler that actually started, and only through the gate. A replay ran no handler
    // and changed nothing the first call had not already busted — re-busting per retry re-purges
    // the CDN and re-queues ISR for a write nobody made. A handler that THREW is busted too: it may
    // have committed (`withIdempotency` records the same throw for that reason), and skipping the
    // bust hid that write behind a stale cache for the TTL. The bust is post-COMMIT either way —
    // invoked inside a transaction, it waits for the root commit and is dropped by a rollback — and
    // `bustAfterCommit` never throws, so it cannot replace this call's answer or its failure.
    if (started && def.cache !== undefined) await bustAfterCommit(name, def.cache.invalidates);
  }
}

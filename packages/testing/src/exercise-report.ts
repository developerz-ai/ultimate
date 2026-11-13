// What one primitive did in the exercise pass, and the room it did it in: the network sealed with
// every allow and mock cleared, the mail fixture, the clock frozen, statements and committed rows
// observed. Every seam is process-global, so the room keeps only what the observed call's own
// async context did — a timer's or another request's work in the same window is not the call's.

import type { DbStatementEvent } from '@ultimat3/core';
import { asyncContext, isSelfOrigin, peerAddressClass, subscribe } from '@ultimat3/core';
import { expectedSeqScanReason, statementFingerprint } from '@ultimat3/db';
import { captureDeterminism, installDeterminism, restoreCapturedDeterminism } from './determinism';
import type { ExerciseDefect } from './exercise-defect';
import { roomMail } from './exercise-room-mail';
import type { StatementCeilingProof } from './exercise-statement-ceiling';
import { routeMatches } from './mock-route';
import type { PlanProof, SentStatement } from './plan-sweep';
import type { LoggedRequest } from './request-log';
import type { ScaleProof, StatementTally } from './scale-sweep';
import {
  captureNetwork,
  isNetworkSealed,
  onDial,
  resetNetwork,
  restoreCapturedNetwork,
  sealNetwork,
  unsealNetwork,
} from './sealed-network';

export type ExerciseEffect =
  | { readonly kind: 'row'; readonly entity: string; readonly op: string; readonly rows: number }
  | { readonly kind: 'mail'; readonly mail: string; readonly count: number }
  /** `refused`: sealed, never sent. A call to this machine is the only one that is not. */
  | {
      readonly kind: 'network';
      readonly method: string;
      readonly host: string;
      readonly refused: boolean;
    }
  | { readonly kind: 'enqueue'; readonly job: string; readonly count: number };

export type ExerciseOutcome = 'reached' | 'refused' | 'unreached' | 'off';

/** B's call before A's positive control, and after it. */
export type TenantLeg = 'before' | 'after';

export interface TenantFinding {
  readonly code: 'X_TENANT_LEAK' | 'X_TENANT_WRITE_CROSSED';
  readonly leg: TenantLeg;
  /** LEAK: where A's canary or id was found, e.g. 'output.items[0].url' or 'effect.mail[0].to' */
  readonly path?: string;
  /** WRITE_CROSSED: the table and the primary key of A's changed row */
  readonly table?: string;
  readonly id?: string;
  /**
   * LEAK from a `tenant: 'none'` job handed nothing of A's: a read across every org that opened no
   * `crossTenant()` scope — its fix is that scope, never a repository scoped to an actor it lacks.
   */
  readonly sweep?: true;
}

/** The tenant proof's verdict on one primitive: B attacked A's rows twice, around A's own call. */
export type TenantProof =
  | { readonly verdict: 'proven' }
  /** The policy admits anonymous: read half skipped, write half kept and clean. */
  | { readonly verdict: 'public'; readonly reason: string }
  /** A's positive control was not reached, so B's clean answer proves nothing. */
  | { readonly verdict: 'unproven'; readonly reason: string }
  | { readonly verdict: 'crossed'; readonly findings: readonly TenantFinding[] };

/** One effect a run killed at `boundary` made a different number of times than a clean run. */
export interface CrashFinding {
  /** `charge`, `charge (started)`, `unwinding`, `compensate:charge`, `ack`. */
  readonly boundary: string;
  /** `forced-fail`: a `compensates: true` job made to fail for good, then unwound. */
  readonly mode: 'clean' | 'forced-fail';
  /** `row:posts:insert`, `mail:receipt→a@x.example`, `network:POST api.example/v1`, `enqueue:x`. */
  readonly effect: string;
  readonly clean: number;
  readonly killed: number;
  /** The last step the clean run had completed before the effect; absent, before the first. */
  readonly after?: string;
  /** The step whose body made the effect, when it was made inside one: it runs again on a retry. */
  readonly inside?: string;
}

/**
 * The crash proof's verdict on a reached job: killed at every distinct step boundary, a loop's rows
 * as one (`crashProof`). `boundaries` is the kills, `crossed` the boundaries they stand for.
 */
export type CrashProof =
  | {
      readonly verdict: 'held';
      readonly boundaries: number;
      readonly crossed?: number;
      readonly reruns: number;
    }
  | {
      readonly verdict: 'diverged';
      readonly boundaries: number;
      readonly crossed?: number;
      /** Lost answers that reran a step: at-least-once, counted, never red. */
      readonly reruns: number;
      readonly findings: readonly CrashFinding[];
    }
  /** The proof itself could not finish: reported, never red. */
  | { readonly verdict: 'unproven'; readonly reason: string };

export interface ExerciseRecord {
  readonly kind: 'action' | 'query' | 'job';
  readonly name: string;
  readonly outcome: ExerciseOutcome;
  readonly code?: string;
  readonly reason?: string;
  /** On an `unreached` one that answered a 5xx: its cause, statement and fields, values masked. */
  readonly defect?: ExerciseDefect;
  readonly statements: number;
  readonly effects: readonly ExerciseEffect[];
  readonly ms: number;
  /** For an `unreached` one: the line to paste into `defineExercise({ … })`. */
  readonly override?: string;
  /**
   * For an `unreached` one no override reaches: the edit that does, in place of the paste — a job
   * whose `tenant(input)` names one fixed org (`exercise-subjects.ts`'s `fixedTenant`).
   */
  readonly fix?: string;
  /** On every record that ran — absent only on `off` and `refused`. The fields above are A's. */
  readonly tenant?: TenantProof;
  /** On a reached job only: its control's input, killed at every step boundary. */
  readonly crash?: CrashProof;
  /** Every statement it sent, planned with no index but the declared ones (`plan-sweep.ts`). */
  readonly plans?: PlanProof;
  /** On a reached primitive: its statement shapes at 2 and at 8 rows a table (`scale-sweep.ts`). */
  readonly scale?: ScaleProof;
  /** On a primitive whose control ran: its busiest call against its statement ceiling. */
  readonly statementCeiling?: StatementCeilingProof;
  /** Wall time of each proof that ran on it; `ms` above is the control's own call. */
  readonly proofMs?: ProofMs;
}

/**
 * Milliseconds per proof of one record. No `plans`: one statement is planned once for every
 * primitive that sent it, so its time is the pass's (`ExercisePhaseMs.plans`), never one record's.
 */
export interface ProofMs {
  /** B's two legs and the snapshots around them, the control's own call excepted. */
  readonly tenant?: number;
  /** Every run the crash proof made. */
  readonly crash?: number;
  /** Its calls at both sizes; seeding the sized graphs is the pass's (`ExercisePhaseMs.scale`). */
  readonly scale?: number;
}

/** Milliseconds per phase of one pass, so a slow pass names its slow part. */
export interface ExercisePhaseMs {
  /** The pass's one seed graph, written. */
  readonly seed: number;
  /** Every primitive's control and its tenant and crash proofs. */
  readonly primitives: number;
  /** The scale sweep: its two sized graphs written, every reached primitive called in each. */
  readonly scale: number;
  /** The plan sweep: every distinct statement the pass sent, planned. */
  readonly plans: number;
}

/** What an effect carried, for the tenant proof's read half: searched, never reported as is. */
export interface EffectPayload {
  /** `effect.mail[0]`, `effect.network[1]`, `effect.enqueue[0]`. */
  readonly path: string;
  readonly value: unknown;
}

const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).host : url);

/** `sealed-network.ts`'s own exemption: this machine and a server this process booted. */
const local = (url: string): boolean => {
  if (isSelfOrigin(url)) return true;
  if (!URL.canParse(url)) return false;
  const name = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (name.toLowerCase() === 'localhost') return true;
  const kind = peerAddressClass(name);
  return kind === 'loopback' || kind === 'unspecified';
};

const tally = (keys: readonly string[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
};

/** What the observed call did — it and the work it started, never a neighbour in its window. */
export interface Observed {
  readonly statements: number;
  readonly effects: readonly ExerciseEffect[];
  /** Calls out the seal refused: each makes the primitive `unreached`, whatever it answered. */
  readonly refusedHosts: readonly string[];
  /** Each mail's addresses and text, each call out's url and body — a sealed one included. */
  readonly payloads: readonly EffectPayload[];
  /** Each statement shape and how often, the `expectedQueryLoop` ones told apart. */
  readonly shapes: readonly StatementTally[];
}

/** What `observe` hands back: what the call did, and its value or what it threw. */
export type Observation<T> =
  | { readonly observed: Observed; readonly value: T }
  | { readonly observed: Observed; readonly error: unknown };

export interface ExerciseRoom extends AsyncDisposable {
  /**
   * Run `fn` — one primitive's call — and hand back what it did. Attributed by async context, never
   * by time: `fn` runs under a marker of this call's own, and a statement, row, mail or dial counts
   * only when it is made under it. Work `fn` starts and does not await carries the marker too, until
   * `observe` returns. `subject`: the primitive the statements are sent for — what the plan sweep
   * reads; none, and they are tallied but not planned.
   */
  observe<T>(subject: string | undefined, fn: () => Promise<T>): Promise<Observation<T>>;
  /** Whether the caller is inside the call being observed — for a seam the room does not own. */
  owns(): boolean;
  /** Every distinct statement text an `observe(subject, …)` call sent, so far. */
  sent(): ReadonlyMap<string, SentStatement>;
}

/**
 * The room's marker in flight — an identity object, never a credential. Never `ctx.requestId`: a job subject runs under the worker's own
 * context, and a request the call did not make has one too.
 */
const scope = asyncContext<object>('the exercise room');

export async function openExerciseRoom(): Promise<ExerciseRoom> {
  const clock = captureDeterminism();
  if (!clock.installed) installDeterminism();
  const network = captureNetwork();
  const sealedBefore = isNetworkSealed();
  // Every allow and mock cleared: a test's `mockFetch` is not the app's, and a call out here is
  // a refusal by definition.
  resetNetwork();
  sealNetwork();
  // The call in flight: a fresh object per `observe`, so a straggler of the call before is not it.
  let marker: object | undefined;
  const owns = (): boolean => marker !== undefined && scope.get() === marker;
  const mail = await roomMail(owns);
  let statements = 0;
  const calls: LoggedRequest[] = [];
  let subject: string | undefined;
  const rows: string[] = [];
  const shapes = new Map<string, { count: number; unexpected: number; expected?: string }>();
  const sent = new Map<string, { primitives: Set<string>; scan?: string }>();
  // Every observer below returns at once unless the sender is the observed call: the bus delivers
  // synchronously in the sender's context (`instrument`), so `owns()` reads the sender's marker.
  const counting = (event: DbStatementEvent): void => {
    if (!owns()) return;
    statements += 1;
    const fingerprint = statementFingerprint(event);
    const shape = shapes.get(fingerprint) ?? { count: 0, unexpected: 0 };
    shape.count += 1;
    if (event.expected === undefined) shape.unexpected += 1;
    else shape.expected = event.expected;
    shapes.set(fingerprint, shape);
    if (subject === undefined) return;
    // Whitespace collapsed, so one builder's two indentations are one statement to plan.
    const text = event.text.replace(/\s+/g, ' ').trim();
    const one = sent.get(text) ?? { primitives: new Set<string>() };
    one.primitives.add(subject);
    // Read here, in the sender's own async context: the scope is the statement's, not the room's.
    const scan = expectedSeqScanReason();
    if (scan !== undefined) one.scan = scan;
    sent.set(text, one);
  };
  // Subscribers on the bus, beside any outer one — released at dispose, never displacing it.
  const offStatements = subscribe('db.statement', (event) => counting(event.payload));
  const offRows = subscribe('entity', (event) => {
    if (!owns()) return;
    if (event.name === 'entity.row') rows.push(`${event.payload.entity}\u0000${event.payload.op}`);
    if (event.name !== 'entity.bulk') return;
    const { entity, op } = event.payload;
    for (let i = 0; i < event.payload.rows; i += 1) rows.push(`${entity}\u0000${op}`);
  });
  const offDials = onDial((call) => {
    if (owns()) calls.push(call);
  });

  const begin = (name: string | undefined): object => {
    subject = name;
    statements = 0;
    shapes.clear();
    rows.length = 0;
    calls.length = 0;
    mail.clear();
    marker = {};
    return marker;
  };
  const end = (): Observed => {
    marker = undefined;
    // A call a route answered never left the process: the app's `setup` installed it.
    const { mocks } = captureNetwork();
    const refused = (call: (typeof calls)[number]): boolean =>
      !local(call.url) && !mocks.some((route) => routeMatches(route, call));
    const effects: ExerciseEffect[] = [
      ...[...tally(rows)].map(([key, count]): ExerciseEffect => {
        const [entity = '', op = ''] = key.split('\u0000');
        return { kind: 'row', entity, op, rows: count };
      }),
      ...[...tally(mail.sent().map((message) => message.mailId))].map(
        ([id, count]): ExerciseEffect => ({ kind: 'mail', mail: id, count }),
      ),
      ...calls.map(
        (call): ExerciseEffect => ({
          kind: 'network',
          method: call.method,
          host: hostOf(call.url),
          refused: refused(call),
        }),
      ),
    ];
    const refusedHosts = calls.filter(refused).map((c) => hostOf(c.url));
    const payloads: EffectPayload[] = [
      ...mail.sent().map((message, i) => ({
        path: `effect.mail[${i}]`,
        value: {
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          replyTo: message.replyTo,
          subject: message.subject,
          text: message.text,
          html: message.html,
          unsubscribeUrl: message.unsubscribeUrl,
        },
      })),
      // Headers left out: a bearer token is not A's row, and a header is no row's text.
      ...calls.map((call, i) => ({
        path: `effect.network[${i}]`,
        value: { url: call.url, body: call.body },
      })),
    ];
    subject = undefined;
    const tallies = [...shapes].map(([fingerprint, shape]) => ({ fingerprint, ...shape }));
    return { statements, effects, refusedHosts, payloads, shapes: tallies };
  };

  return {
    observe: async <T>(name: string | undefined, fn: () => Promise<T>): Promise<Observation<T>> => {
      const mine = begin(name);
      try {
        const value = await scope.run(mine, fn);
        return { observed: end(), value };
      } catch (error) {
        return { observed: end(), error };
      }
    },
    owns,
    sent: () => sent,
    [Symbol.asyncDispose]: async (): Promise<void> => {
      // Each restore runs whatever the one before it did: a throw must not strand a seam.
      try {
        mail[Symbol.dispose]();
      } finally {
        offDials();
        offRows();
        offStatements();
        restoreCapturedNetwork(network);
        if (!sealedBefore) unsealNetwork();
        restoreCapturedDeterminism(clock);
      }
    },
  };
}

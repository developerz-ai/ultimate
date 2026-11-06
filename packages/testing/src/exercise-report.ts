// What one primitive did in the exercise pass, and the room it did it in: the network sealed with
// every allow and mock cleared, the mail fixture, the clock frozen, statements and committed rows
// observed. Every seam is process-global, so the room hands back exactly what it found.

import { isSelfOrigin, peerAddressClass } from '@ultimat3/core';
import type { StatementObserver } from '@ultimat3/db';
import {
  expectedSeqScanReason,
  setStatementObserver,
  statementFingerprint,
  statementObserver,
} from '@ultimat3/db';
import type { RowObserver } from '@ultimat3/entity';
import { captureDeterminism, installDeterminism, restoreCapturedDeterminism } from './determinism';
import { testMail } from './fixture-mail';
import type { PlanProof, SentStatement } from './plan-sweep';
import type { ScaleProof, StatementTally } from './scale-sweep';
import {
  captureNetwork,
  isNetworkSealed,
  requestLog,
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
  /** The last step the clean run had written before the effect; absent, before the first. */
  readonly after?: string;
}

/** The crash proof's verdict on a reached job: killed at every step boundary (`crashProof`). */
export type CrashProof =
  | { readonly verdict: 'held'; readonly boundaries: number; readonly reruns: number }
  | {
      readonly verdict: 'diverged';
      readonly boundaries: number;
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
  readonly statements: number;
  readonly effects: readonly ExerciseEffect[];
  readonly ms: number;
  /** For an `unreached` one: the line to paste into `defineExercise({ … })`. */
  readonly override?: string;
  /** On every record that ran — absent only on `off` and `refused`. The fields above are A's. */
  readonly tenant?: TenantProof;
  /** On a reached job only: its control's input, killed at every step boundary. */
  readonly crash?: CrashProof;
  /** Every statement it sent, planned with no index but the declared ones (`plan-sweep.ts`). */
  readonly plans?: PlanProof;
  /** On a reached primitive: its statement shapes at 2 and at 8 rows a table (`scale-sweep.ts`). */
  readonly scale?: ScaleProof;
}

/** What an effect carried, for the tenant proof's read half: searched, never reported as is. */
export interface EffectPayload {
  /** `effect.mail[0]`, `effect.network[1]`, `effect.enqueue[0]`. */
  readonly path: string;
  readonly value: unknown;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `publishPost: { actor, input: (drawn) => ({ ...drawn, postId: '<…>' }) },` — valid TS to paste. */
export function overrideLine(name: string, idFields: readonly string[]): string {
  const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
  const bound = idFields
    .map((field) => `, ${IDENTIFIER.test(field) ? field : JSON.stringify(field)}: '<a real id>'`)
    .join('');
  return `${key}: { actor: <an actor its policy permits>, input: (drawn) => ({ ...drawn${bound} }) },`;
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

/** What happened between `begin()` and `end()`. */
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

export interface ExerciseRoom extends AsyncDisposable {
  /** `subject`: the primitive the statements until `end()` are sent for — what the plan sweep reads. */
  begin(subject?: string): void;
  end(): Observed;
  /** Every distinct statement text sent between a `begin(subject)` and its `end()`, so far. */
  sent(): ReadonlyMap<string, SentStatement>;
}

export async function openExerciseRoom(): Promise<ExerciseRoom> {
  const { setRowObserver } = await import('@ultimat3/entity');
  const clock = captureDeterminism();
  if (!clock.installed) installDeterminism();
  const network = captureNetwork();
  const sealedBefore = isNetworkSealed();
  // Every allow and mock cleared: a test's `mockFetch` is not the app's, and a call out here is
  // a refusal by definition.
  resetNetwork();
  sealNetwork();
  const mail = await testMail();
  let statements = 0;
  let logFrom = 0;
  let subject: string | undefined;
  const rows: string[] = [];
  const shapes = new Map<string, { count: number; unexpected: number; expected?: string }>();
  const sent = new Map<string, { primitives: Set<string>; scan?: string }>();
  const previousStatements = statementObserver();
  const counting: StatementObserver = {
    onStatement: (event) => {
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
    },
  };
  setStatementObserver(counting);
  const rowObserver: RowObserver = {
    onChange: (change) => rows.push(`${change.entity}\u0000${change.op}`),
    onBulk: (change) => {
      for (let i = 0; i < change.rows; i += 1) rows.push(`${change.entity}\u0000${change.op}`);
    },
  };
  const previousRows = setRowObserver(rowObserver);

  return {
    begin: (name) => {
      subject = name;
      statements = 0;
      shapes.clear();
      rows.length = 0;
      mail.clear();
      logFrom = requestLog().length;
    },
    end: (): Observed => {
      const calls = requestLog().slice(logFrom);
      const effects: ExerciseEffect[] = [
        ...[...tally(rows)].map(([key, count]): ExerciseEffect => {
          const [entity = '', op = ''] = key.split('\u0000');
          return { kind: 'row', entity, op, rows: count };
        }),
        ...[...tally(mail.outbox().map((sent) => sent.message.mailId))].map(
          ([id, count]): ExerciseEffect => ({ kind: 'mail', mail: id, count }),
        ),
        ...calls.map(
          (call): ExerciseEffect => ({
            kind: 'network',
            method: call.method,
            host: hostOf(call.url),
            refused: !local(call.url),
          }),
        ),
      ];
      const refusedHosts = calls.filter((call) => !local(call.url)).map((c) => hostOf(c.url));
      const payloads: EffectPayload[] = [
        ...mail.outbox().map(({ message }, i) => ({
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
    },
    sent: () => sent,
    [Symbol.asyncDispose]: async (): Promise<void> => {
      // Each restore runs whatever the one before it did: a throw must not strand a seam.
      try {
        mail[Symbol.dispose]();
      } finally {
        setRowObserver(previousRows);
        setStatementObserver(previousStatements);
        restoreCapturedNetwork(network);
        if (!sealedBefore) unsealNetwork();
        restoreCapturedDeterminism(clock);
      }
    },
  };
}

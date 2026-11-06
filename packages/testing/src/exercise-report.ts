// What one primitive did in the exercise pass, and the room it did it in: the network sealed with
// every allow and mock cleared, the mail fixture, the clock frozen, statements and committed rows
// observed. Every seam is process-global, so the room hands back exactly what it found.

import { isSelfOrigin, peerAddressClass } from '@ultimat3/core';
import type { StatementObserver } from '@ultimat3/db';
import { setStatementObserver, statementObserver } from '@ultimat3/db';
import type { RowObserver } from '@ultimat3/entity';
import { captureDeterminism, installDeterminism, restoreCapturedDeterminism } from './determinism';
import { testMail } from './fixture-mail';
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
}

export interface ExerciseRoom extends AsyncDisposable {
  begin(): void;
  end(): Observed;
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
  const rows: string[] = [];
  const previousStatements = statementObserver();
  const counting: StatementObserver = {
    onStatement: () => {
      statements += 1;
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
    begin: () => {
      statements = 0;
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
      return { statements, effects, refusedHosts };
    },
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

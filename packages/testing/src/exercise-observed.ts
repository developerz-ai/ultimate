// Several recordings of one primitive, as one: the control records each CALL alone, so what its
// override's `input` did between two calls (a select, a row, a mail) is never the primitive's.

import type { EffectPayload, ExerciseEffect, Observed } from './exercise-report';
import type { StatementTally } from './scale-sweep';

const EMPTY: Observed = { statements: 0, effects: [], refusedHosts: [], payloads: [], shapes: [] };

/** A count effect's identity: two segments' inserts into one table are one effect, summed. */
const countKey = (effect: ExerciseEffect): string | undefined => {
  if (effect.kind === 'row') return `row\u0000${effect.entity}\u0000${effect.op}`;
  if (effect.kind === 'mail') return `mail\u0000${effect.mail}`;
  if (effect.kind === 'enqueue') return `enqueue\u0000${effect.job}`;
  return undefined;
};

const added = (one: ExerciseEffect, other: ExerciseEffect): ExerciseEffect => {
  if (one.kind === 'row' && other.kind === 'row') return { ...one, rows: one.rows + other.rows };
  if (one.kind === 'mail' && other.kind === 'mail')
    return { ...one, count: one.count + other.count };
  if (one.kind === 'enqueue' && other.kind === 'enqueue') {
    return { ...one, count: one.count + other.count };
  }
  return one;
};

function mergeEffects(lists: readonly (readonly ExerciseEffect[])[]): readonly ExerciseEffect[] {
  const out: ExerciseEffect[] = [];
  const at = new Map<string, number>();
  for (const effect of lists.flat()) {
    const key = countKey(effect);
    const index = key === undefined ? undefined : at.get(key);
    if (index === undefined) {
      if (key !== undefined) at.set(key, out.length);
      out.push(effect);
    } else out[index] = added(out[index] as ExerciseEffect, effect);
  }
  return out;
}

/** `effect.mail[0]` of the second segment is the merged list's `effect.mail[n]`, n its offset. */
function mergePayloads(lists: readonly (readonly EffectPayload[])[]): readonly EffectPayload[] {
  const offsets = new Map<string, number>();
  const out: EffectPayload[] = [];
  for (const list of lists) {
    const seen = new Map<string, number>();
    for (const payload of list) {
      const match = /^(.*)\[(\d+)\]$/.exec(payload.path);
      if (match === null) {
        out.push(payload);
        continue;
      }
      const [, base = '', index = '0'] = match;
      const shifted = (offsets.get(base) ?? 0) + Number(index);
      seen.set(base, Math.max(seen.get(base) ?? 0, Number(index) + 1));
      out.push({ ...payload, path: `${base}[${shifted}]` });
    }
    for (const [base, count] of seen) offsets.set(base, (offsets.get(base) ?? 0) + count);
  }
  return out;
}

function mergeShapes(lists: readonly (readonly StatementTally[])[]): readonly StatementTally[] {
  const byPrint = new Map<string, StatementTally>();
  for (const shape of lists.flat()) {
    const known = byPrint.get(shape.fingerprint);
    byPrint.set(
      shape.fingerprint,
      known === undefined
        ? shape
        : {
            ...known,
            ...(shape.expected === undefined ? {} : { expected: shape.expected }),
            count: known.count + shape.count,
            unexpected: known.unexpected + shape.unexpected,
          },
    );
  }
  return [...byPrint.values()];
}

/** The segments as one recording: counts summed, lists in order. None is the empty recording. */
export function mergeObserved(segments: readonly Observed[]): Observed {
  if (segments.length === 0) return EMPTY;
  if (segments.length === 1) return segments[0] as Observed;
  return {
    statements: segments.reduce((sum, one) => sum + one.statements, 0),
    effects: mergeEffects(segments.map((one) => one.effects)),
    refusedHosts: segments.flatMap((one) => one.refusedHosts),
    payloads: mergePayloads(segments.map((one) => one.payloads)),
    shapes: mergeShapes(segments.map((one) => one.shapes)),
  };
}

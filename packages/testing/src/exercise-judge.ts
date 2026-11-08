// What one primitive's control call made of its record, judged: reached, or unreached with the
// code, the reason and the paste line — under the entry key its primitive is written as, which is
// `kind:name` when two kinds share the name (`labelFor`).

import type { ExerciseVerdict } from '@ultimat3/core';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import { exerciseEntryKey } from './define-exercise';
import { driftOverrideLine } from './exercise-drift-hint';
import type { Sampler } from './exercise-input';
import { idStem } from './exercise-input';
import type { Observed } from './exercise-report';
import { overrideLine } from './exercise-report';
import type { Subject } from './exercise-subjects';

/**
 * Who `subject` is, in a key and on the room: its bare name, or `kind:name` when another kind is
 * registered under the same name — so neither reads the other's entry, statements or proofs.
 */
export const labelFor = (subjects: readonly Subject[]) => {
  const kinds = new Map<string, Set<string>>();
  for (const { kind, name } of subjects) kinds.set(name, (kinds.get(name) ?? new Set()).add(kind));
  return (subject: Pick<Subject, 'kind' | 'name'>): string =>
    (kinds.get(subject.name)?.size ?? 0) > 1
      ? exerciseEntryKey(subject.kind, subject.name)
      : subject.name;
};

const codeOf = (error: unknown): string | undefined => {
  if (isUltimateError(error)) return error.code;
  return typeof error === 'string' ? /^(X_[A-Z0-9_]+)/.exec(error)?.[1] : undefined;
};

const reasonOf = (error: unknown): string =>
  isUltimateError(error) ? error.cause : typeof error === 'string' ? error : renderThrowable(error);

export interface Run {
  readonly verdict: ExerciseVerdict;
  readonly answered: boolean;
  readonly lastError: unknown;
  readonly lastInput: unknown;
}

export function judged(
  subject: Subject,
  key: string,
  run: Run,
  observed: Observed,
  sampler: Sampler,
) {
  const idFields = (input: unknown): readonly string[] =>
    typeof input === 'object' && input !== null
      ? Object.keys(input).filter((key) => idStem(key) !== undefined)
      : [];
  const unreached = (code: string | undefined, reason: string) => ({
    outcome: 'unreached' as const,
    ...(code === undefined ? {} : { code }),
    reason,
    override: overrideLine(key, idFields(run.lastInput)),
  });
  if (observed.refusedHosts.length > 0) {
    // A call out is a refusal whatever the handler made of it: sealed, so never sent.
    const hosts = [...new Set(observed.refusedHosts)].join(', ');
    return unreached('X_TEST_NETWORK_SEALED', `called out to ${hosts}: sealed, never sent`);
  }
  if (run.verdict.kind === 'pass' && run.answered) return { outcome: 'reached' as const };
  if (run.verdict.kind === 'drift') {
    // The field no draw can fill, named: `...drawn` alone told the author nothing to write.
    const fields = idFields(run.lastInput);
    return {
      ...unreached('X_CONTRACT_DRIFT', 'its input schema refused every generated value'),
      override: driftOverrideLine(key, subject.input, sampler, fields),
    };
  }
  if (run.verdict.kind === 'defect') {
    return unreached(codeOf(run.verdict.error) ?? 'X_CONTRACT_DEFECT', run.verdict.defect);
  }
  return unreached(codeOf(run.lastError), reasonOf(run.lastError));
}

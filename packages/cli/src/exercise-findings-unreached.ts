// `X_CONTRACT_EXERCISE_UNREACHED`'s finding: a primitive no run got to as an allowed actor, and the
// ONE edit that can change that — a policy predicate that refused, the entry the file already holds,
// or the entry to paste. Only the paste carries the run's drawn ids; the other two are stable.

import { ERROR_DOCS_URL, renderCauseValue, renderFixShellArg } from '@ultimat3/core';
import type { ExerciseOverrides, ExerciseRecord } from '@ultimat3/testing';
import type { Finding } from './output';

/** The file an override is pasted into — `defineExercise()`'s one home. */
export const EXERCISE_FILE = 'apps/web/exercise.ts';

/** The overrides `apps/web/exercise.ts` declared, `undefined` when the app has no such file. */
export type ExerciseFileFacts = ExerciseOverrides | undefined;

const PASTE_NOTE =
  "an inline .contract({ exercise: {...} }) in a test is not read here: move it, then pass .contract({ exercise }); or give the entry { off: '<why>' }";

/** `can()`'s denial when its predicate refused — `<label> predicate returned false` (policy.ts). */
const PREDICATE_REFUSED = /^(\S+) predicate returned (?:false|neither a boolean nor a decision)/;

const hasEntry = (facts: ExerciseFileFacts, record: ExerciseRecord): boolean =>
  facts !== undefined &&
  (facts.entries.has(`${record.kind}:${record.name}`) || facts.entries.has(record.name));

/**
 * The predicate's label is the permission `can()` was handed; its resource names the slice whose
 * `policy.ts` `x g` wrote. No input passes a predicate that refuses every seeded actor, so the edit
 * is the predicate; `x policy explain` prints the clause that decided, for an action or a query.
 */
const predicateFix = (record: ExerciseRecord, label: string, rerun: string): string => {
  const name = renderFixShellArg(record.name, '<name>');
  const show =
    record.kind === 'action' || record.kind === 'query'
      ? `x policy explain ${name} --json`
      : 'x policy list --json';
  const permission = renderFixShellArg(label, '<permission>');
  const resource = permission.includes(':') ? permission.split(':')[0] : undefined;
  const where =
    resource === undefined
      ? `the ${permission} predicate (${show} names its clause)`
      : `the predicate of can('${permission}', …) in apps/web/app/${resource}/policy.ts, else the file declaring it (${show} names the clause)`;
  return `edit ${where} so an actor the pass seeds passes it: it returned false for every one, and no ${EXERCISE_FILE} entry changes that — or give the ${name} entry { off: '<why>' }; ${rerun}`;
};

const pasteFix = (record: ExerciseRecord, facts: ExerciseFileFacts, rerun: string): string => {
  const entry = (
    record.override ?? `${record.name}: { input: { /* a value it accepts */ } }`
  ).replace(/[\s,]+$/, '');
  return facts === undefined
    ? `import { defineExercise } from '@ultimat3/testing'; export const exercise = defineExercise({ ${entry} });   # create ${EXERCISE_FILE} with this (${PASTE_NOTE}); ${rerun}`
    : `${entry},   # paste inside export const exercise = defineExercise({ … }) in ${EXERCISE_FILE} (${PASTE_NOTE}); ${rerun}`;
};

/**
 * The fix, from its first character: a refusing predicate's edit; else the edit to the entry the
 * file holds (a second key is TS1117); else the paste — into a file that exists, the bare entry
 * (thirty findings are thirty entries inside the ONE export); with no file yet, the whole file.
 */
export const unreachedFinding =
  (facts: ExerciseFileFacts) =>
  (record: ExerciseRecord): Finding => {
    const name = renderFixShellArg(record.name, '<name>');
    const stopped = record.code === undefined ? '' : ` — stopped on ${record.code}`;
    const why = record.reason === undefined ? '' : ` (${renderCauseValue(record.reason)})`;
    const rerun = `then: x exercise ${name} --json`;
    const label = PREDICATE_REFUSED.exec(record.reason ?? '')?.[1];
    const fix =
      label !== undefined
        ? predicateFix(record, label, rerun)
        : hasEntry(facts, record)
          ? `edit the ${name} entry already in ${EXERCISE_FILE} (its input or actor; a second ${name}: key is TS1117), or give it { off: '<why>' }; ${rerun}`
          : pasteFix(record, facts, rerun);
    return {
      code: 'X_CONTRACT_EXERCISE_UNREACHED',
      cause: `${record.kind} ${renderCauseValue(record.name)} never reached its handler as an allowed actor in the exercise pass${stopped}${why}${defectOf(record)}`,
      fix: record.fix ?? fix,
      docs: ERROR_DOCS_URL,
      at: EXERCISE_FILE,
    };
  };

/**
 * A 5xx's own words — the cause testing recorded (credential values already masked there) and the
 * fields a validation failure names. The statement is inside the cause, so it is not said twice.
 */
const defectOf = (record: ExerciseRecord): string => {
  const defect = record.defect;
  if (defect === undefined) return '';
  const fields =
    defect.fields === undefined
      ? ''
      : ` at ${defect.fields.map((field) => renderCauseValue(field)).join(', ')}`;
  return ` — cause: ${renderCauseValue(defect.cause)}${fields}`;
};

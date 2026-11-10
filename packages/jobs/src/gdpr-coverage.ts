// What `personalData()` (entity's marker) adds to `defineSubject()`: proof the declared subjects
// cover every marked column. A subject's plan says WHICH tables it reaches and how each is treated;
// this says whether that treatment clears the marked columns, and whether every marked entity is
// reached at all. Pure — plans and marked entities in, refusals out — so a run and a check agree.

import type { PersonalDataEntity } from '@ultimat3/entity';
import { personalDataEntities, registeredEntities } from '@ultimat3/entity';
import { PersonalDataUnerasedError, PersonalDataUnreachedError } from './gdpr-errors';
import type { Subject } from './subject';
import { registeredSubjects } from './subject';
import type { SubjectPlan } from './subject-plan';
import { planSubject } from './subject-plan';

const markedOf = (
  marked: readonly PersonalDataEntity[],
  table: string,
): PersonalDataEntity | undefined => marked.find((each) => each.entity.$name === table);

/**
 * Every reached table whose treatment would leave a marked column: `'delete'` clears the row,
 * `{ retain }` is a stated reason (printed in the export's index), and `{ anonymize }` must name
 * EVERY marked property — a value it overwrites is no longer the person's.
 */
export function unerasedPersonalData(
  plan: SubjectPlan,
  marked: readonly PersonalDataEntity[] = personalDataEntities(),
): readonly PersonalDataUnerasedError[] {
  return plan.steps.flatMap((step) => {
    const entry = markedOf(marked, step.entity);
    const { treatment } = step;
    if (entry === undefined || typeof treatment !== 'object' || !('anonymize' in treatment)) {
      return [];
    }
    const left = entry.columns
      .map((column) => column.property)
      .filter((property) => !Object.hasOwn(treatment.anonymize, property));
    return left.length === 0
      ? []
      : [
          new PersonalDataUnerasedError({
            subject: plan.subject,
            table: step.entity,
            columns: left,
          }),
        ];
  });
}

/** Every marked entity no plan reaches, in the registry's name order. */
export function unreachedPersonalData(
  plans: readonly SubjectPlan[],
  marked: readonly PersonalDataEntity[] = personalDataEntities(),
): readonly PersonalDataUnreachedError[] {
  const reached = new Set(plans.flatMap((plan) => plan.steps.map((step) => step.entity)));
  const subjects = plans.map((plan) => plan.subject);
  return marked
    .filter((entry) => !reached.has(entry.entity.$name))
    .map(
      (entry) =>
        new PersonalDataUnreachedError({
          table: entry.entity.$name,
          columns: entry.columns.map((column) => column.property),
          subjects,
        }),
    );
}

/**
 * The whole check over this process's declarations — what `x exercise` lists, once every entity
 * module has loaded. A subject whose own plan is refused (`X_SUBJECT_*`) raises that refusal first:
 * coverage of an unplannable subject is not a question with an answer.
 */
export function personalDataProblems(
  subjects: readonly Subject<never>[] = registeredSubjects(),
  marked: readonly PersonalDataEntity[] = personalDataEntities(),
): readonly (PersonalDataUnerasedError | PersonalDataUnreachedError)[] {
  // `planSubject` and not `subject-jobs.ts`'s `plannedSubject`: that one is where a run asks
  // `unerasedPersonalData`, and importing it back would be a cycle.
  const plans = subjects.map((subject) => {
    const { plan, problems } = planSubject({
      subject: subject.entity,
      tables: subject.init.tables,
      columns: subject.init.columns,
      entries: registeredEntities(),
    });
    const [first] = problems;
    if (first !== undefined) throw first;
    return plan;
  });
  return [
    ...plans.flatMap((plan) => unerasedPersonalData(plan, marked)),
    ...unreachedPersonalData(plans, marked),
  ];
}

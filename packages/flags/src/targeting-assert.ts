// Single responsibility: declaration-time validation of a `FlagTargeting`, the way `can()`
// validates its permission rather than waiting for a request. Split from `targeting.ts` so that
// file stays the evaluation path — the one that runs inside a policy predicate and must not grow.

import { BUCKETS } from './bucket';
import { flagTargetingInvalid, renderGiven } from './errors';
import { BUILT_IN_SUBJECT_KINDS, isBuiltInSubjectKind } from './subject';
import type { FlagTargeting } from './targeting';

/**
 * The three flat allow lists, all checked by the same loop. They are ONE rank with `subjects` at
 * evaluation time, and CLAUDE.md says so — so a validation rule that reached only `subjects` made
 * three quarters of that rank unchecked.
 */
const ID_LISTS = ['actors', 'roles', 'orgs'] as const;

type IdListField = (typeof ID_LISTS)[number];

const LIST_EXAMPLE: Readonly<Record<IdListField, string>> = {
  actors: 'user_100',
  roles: 'admin',
  orgs: 'org_acme',
};

/**
 * Each rule closes a way for a flag to look wired and decide something other than what it says:
 *
 * | Rejected | Why |
 * |---|---|
 * | `rollout: 0.5` | read as a fraction it means "half", read as a percentage it means "nobody" |
 * | `default: true` with a `rollout` | the two answer the same actors and disagree; there is no reading of "on for everyone, and also on for 10%" |
 * | `bucketBy` with no `rollout` | it names what a rollout divides, and there is no rollout to divide |
 * | a blank `bucketBy` | names no kind at all |
 * | `subjects.actor` / `subjects.org` | `actors` and `orgs` are the one spelling; two would disagree |
 * | a `subjects` entry that is not a list of non-empty ids | reachable from a store snapshot, and it matches nothing while reading as an allow list |
 *
 * The checks narrow by hand rather than through a schema: this package's other runtime re-checks
 * (`Number.isInteger`, the expiry pattern in `flag.ts`) do the same, and a dependency here would
 * buy one validation on a path that must stay allocation-free.
 */
export function assertTargeting(key: string, targeting: FlagTargeting): void {
  const declared = assertObject(key, targeting);
  const { bucketBy, rollout } = declared;
  assertDefault(key, declared.default);
  for (const field of ID_LISTS) assertIdList(key, field, declared[field]);
  if (declared.subjects !== undefined) assertSubjects(key, declared.subjects);
  if (bucketBy !== undefined) {
    if (typeof bucketBy !== 'string' || bucketBy.trim() === '') {
      throw flagTargetingInvalid(
        key,
        `bucketBy is ${JSON.stringify(bucketBy)}, which names no subject kind`,
        `set bucketBy to a subject kind — '${BUILT_IN_SUBJECT_KINDS.join("', '")}', or one your call site passes — in defineFlag({ key: '${key}' })`,
      );
    }
    if (rollout === undefined) {
      throw flagTargetingInvalid(
        key,
        `bucketBy is '${bucketBy}' with no rollout, so it divides nothing`,
        `add a rollout to defineFlag({ key: '${key}' }), or remove bucketBy`,
      );
    }
  }
  if (rollout === undefined) return;
  if (!Number.isInteger(rollout)) {
    const problem = `rollout is ${rollout}; a rollout is a whole percentage, not a fraction`;
    throw flagTargetingInvalid(key, problem);
  }
  if (rollout < 0 || rollout > BUCKETS) {
    throw flagTargetingInvalid(key, `rollout is ${rollout}, outside 0-${BUCKETS}`);
  }
  if (declared.default) {
    throw flagTargetingInvalid(key, `default is true and rollout is ${rollout}; the two disagree`);
  }
}

/**
 * The argument is a targeting AT ALL, established before any field is read.
 *
 * The declared parameter type is a promise the CALLER makes, and this function exists for the case
 * nobody made it: `applyFlagSnapshot` lands a store payload no type ever saw, so a `null` used to
 * reach the destructure as a bare `TypeError` and a bare string used to pass every check —
 * `default`, `actors`, `rollout` and `subjects` are all `undefined` on a string — and then answer
 * `undefined` from a function declared to return `boolean`.
 */
function assertObject(key: string, targeting: FlagTargeting): FlagTargeting {
  const given: unknown = targeting;
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    throw flagTargetingInvalid(
      key,
      `targeting is ${renderGiven(given)}, which is not a targeting object`,
      `give the flag a targeting object — { default: false } — in defineFlag({ key: '${key}' })`,
    );
  }
  return given as FlagTargeting;
}

/**
 * `default` is the one REQUIRED field, and it was the one field with no shape check while
 * `rollout` got `Number.isInteger`. `isEnabled` is declared to return `boolean`: a missing default
 * answered `undefined` through that type and `{ default: 'yes' }` answered the string, so every
 * `=== true` / `=== false` call site silently changed meaning without a single failure anywhere.
 */
function assertDefault(key: string, value: boolean): void {
  if (typeof value === 'boolean') return;
  throw flagTargetingInvalid(
    key,
    `default is ${renderGiven(value)}; a flag answers true or false and nothing else`,
    `set default to true or false in defineFlag({ key: '${key}' })`,
  );
}

/**
 * A list of non-empty ids, or absent. The check that matters is `Array.isArray`, and its absence
 * was a silent grant: `includes` on a STRING matches by substring, so `actors: 'user_100'` answered
 * `true` for `user_1`, `user_10`, `ser_10` and `u`. `roles` failed the other way — a string has no
 * `.some()`, so it threw a bare `TypeError` out of `evaluateTargeting`, which runs inside policy
 * predicates and render passes.
 */
function assertIdList(key: string, field: IdListField, list: unknown): void {
  if (list === undefined) return;
  const fix = `set ${field} to a list of ids — ${field}: ['${LIST_EXAMPLE[field]}'] — in defineFlag({ key: '${key}' })`;
  if (!Array.isArray(list)) {
    throw flagTargetingInvalid(
      key,
      `${field} is ${renderGiven(list)}, not a list of ids — a bare string is matched by substring, so it claims every id inside it`,
      fix,
    );
  }
  for (const id of list as readonly unknown[]) {
    if (typeof id !== 'string' || id === '') {
      throw flagTargetingInvalid(key, `${field} holds ${renderGiven(id)}, which is not an id`, fix);
    }
  }
}

function assertSubjects(key: string, subjects: Readonly<Record<string, readonly string[]>>): void {
  const fix = `give each subjects entry a kind and a list of ids — { bank: ['bank_integration:bbva'] } — in defineFlag({ key: '${key}' })`;
  for (const [kind, ids] of Object.entries<unknown>(subjects)) {
    if (kind.trim() === '') throw flagTargetingInvalid(key, 'a subjects kind is blank', fix);
    if (isBuiltInSubjectKind(kind)) {
      throw flagTargetingInvalid(
        key,
        `subjects.${kind} restates a built-in kind`,
        `use ${kind === 'org' ? 'orgs' : 'actors'} instead of subjects.${kind} in defineFlag({ key: '${key}' })`,
      );
    }
    if (!Array.isArray(ids)) {
      throw flagTargetingInvalid(key, `subjects.${kind} is not a list of ids`, fix);
    }
    for (const id of ids as readonly unknown[]) {
      if (typeof id !== 'string' || id === '') {
        throw flagTargetingInvalid(key, `subjects.${kind} holds an id that is not a string`, fix);
      }
    }
  }
}

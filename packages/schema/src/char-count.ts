// Single responsibility: how many CHARACTERS a string has. One definition, because the rule that
// rejects a string and the message that describes it must quote the same number — `validators.ts`
// counts here, `describe-value.ts` renders from here, and they disagreed on any astral value.

/**
 * Code points, not UTF-16 code units — the unit `json-schema.ts` publishes `minLength`/`maxLength`
 * in (JSON Schema defines them over code points), the unit the messages have always said ("chars"),
 * and the unit Postgres' `char_length` counts in. `'👍'.length` is 2, so a count in code units
 * refused a value the published schema, a human and the database all call one character — and,
 * once `describeValue` also read `.length`, `t.string.min(3).safeParse('👍a')` answered
 * "at least 3 chars, received a string of 3 characters", an off-by-one an agent cannot debug.
 *
 * Only a surrogate makes the two counts differ, so the string is walked only when one is present:
 * every ASCII value keeps the O(1) read.
 */
const HAS_SURROGATE = /[\uD800-\uDBFF]/;

export function charCount(value: string): number {
  return HAS_SURROGATE.test(value) ? [...value].length : value.length;
}

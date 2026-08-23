// The two refusals raised while a SCHEMA is still being written — a column and an invariant — and
// why neither goes through `invariantViolated`: that builder's fix is
// `x entities describe <entityName> --json`, which needs an entity that exists. Passing the
// literal `'column'` emitted `x entities describe column --json`, which answers
// `X_DECLARATION_UNKNOWN` — a fix line that raises a second, unrelated error (issue #290).
//
// So the fix is a parameter: every caller supplies the EDIT that repairs its own refusal, the
// shape `arrayElementRefused` (`array-element.ts`) already ships. Two builders rather than one
// with a `subject` parameter, because `fix-scan.ts` only reads a fix literal at a call site whose
// callee constructs the error itself — a wrapper delegating to a shared inner one would take all
// 30 of these fix lines back out of `x verify`'s `errors` step.

import { EntityError } from './errors';

/**
 * A column refusing a value or its own declaration. `column.<rule>` is the cause's subject and is
 * unchanged from what `invariantViolated('column', …)` rendered: the defect was the fix line, and
 * a cause a hundred tests already read is not the place to make a second change.
 */
export const refuseColumn = (rule: string, detail: string, fix: string): never => {
  throw new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `column.${rule}: ${detail}`,
    fix,
  });
};

/**
 * An invariant refusing its own declaration, before any entity holds it — `matches(/…/g)` and an
 * `eq` against a column of some other entity's `c`. Same reason as above: `invariantColumns` knows
 * the entity name and passes it, these two are reached from the expression builder, which does not.
 */
export const refuseInvariant = (rule: string, detail: string, fix: string): never => {
  throw new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `invariant.${rule}: ${detail}`,
    fix,
  });
};

// Single responsibility: compose a `scoped()` policy's predicate into a read's source BEFORE the
// page is cut, so a viewer whose hidden rows precede their visible ones still gets a full page —
// and keep the JS rule the authority: it runs on every row the narrowed source returns.
// `ruleCheckOf` hands a page the unchecked rows and the rule apart (`page-window.ts`).
import type { ScopeCondition, ScopeOperator } from '@ultimat3/policy';
import { policyScope } from '@ultimat3/policy';
import { QueryScopeUncomposableError } from './errors';
import type { QueryPolicy, QuerySubject, QuerySurface } from './policy-gate';
import { queryRowAdmitted } from './policy-gate';
import type { FilterOp, QueryShape, SeekKey } from './shape';
import type { SqlSource, SqlText } from './source';
import { Builder } from './source';

/** Each scope operator as the `Builder` filter that means it — NULL is `= null` / `!= null`. */
const AS_FILTER: Readonly<Record<ScopeOperator, FilterOp>> = {
  eq: '=',
  neq: '!=',
  in: 'in',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  'is-null': '=',
  'is-not-null': '!=',
};

const operand = (condition: ScopeCondition): unknown =>
  condition.op === 'is-null' || condition.op === 'is-not-null' ? null : condition.value;

/**
 * `source` narrowed by the policy's scope for `subject.actor`, or `source` itself when the policy
 * declares none. The conditions become ordinary `.compare()` filters, so they reach the SQL text,
 * the live matcher's shape and a provider's `RowWindow.filters` exactly as a `.where()` would.
 */
export function composeScope(
  source: SqlSource<object>,
  policy: QueryPolicy,
  subject: QuerySubject,
  surface: QuerySurface,
): SqlSource<object> {
  const conditions = policyScope(policy, subject.actor);
  if (conditions === undefined) return source;
  if (!(source instanceof Builder)) throw new QueryScopeUncomposableError(subject.query);
  const narrowed = conditions.reduce<Builder<object>>(
    (builder, condition) =>
      builder.compare(condition.column, AS_FILTER[condition.op], operand(condition)),
    source,
  );
  return new RuleChecked(narrowed, policy, subject, surface);
}

/**
 * A rule-checked source taken apart: the narrowed reads BEFORE the rule, and the rule itself.
 * A page needs both — its cursor and `hasMore` come from the rows the source read, never from the
 * rows the rule left, or a dropped probe row ended a listing that had rows left.
 */
export interface RuleCheck {
  seekUnchecked(after: SeekKey | null, limit: number): SqlSource<object>;
  admits(row: object): boolean;
}

/** The rule and its unchecked source, when `source` is a composed scope; `null` otherwise. */
export function ruleCheckOf(source: SqlSource<object>): RuleCheck | null {
  return source instanceof RuleChecked ? source : null;
}

/**
 * The narrowed source, with the rule run per returned row. Survives `seek()` and `total()` — the
 * page and the live window are built from those, and a check lost there is a check never run.
 */
class RuleChecked implements SqlSource<object>, RuleCheck {
  constructor(
    private readonly inner: Builder<object>,
    private readonly policy: QueryPolicy,
    private readonly subject: QuerySubject,
    private readonly surface: QuerySurface,
  ) {}

  toSQL(): SqlText {
    return this.inner.toSQL();
  }

  shape(): QueryShape {
    return this.inner.shape();
  }

  total(): SqlSource<object> {
    return this.wrap(this.inner.total());
  }

  seek(after: SeekKey | null, limit: number): SqlSource<object> {
    return this.wrap(this.inner.seek(after, limit));
  }

  async execute(): Promise<readonly object[]> {
    const rows = await this.inner.execute();
    return rows.filter((row) => this.admits(row));
  }

  seekUnchecked(after: SeekKey | null, limit: number): SqlSource<object> {
    return this.inner.seek(after, limit);
  }

  admits(row: object): boolean {
    return queryRowAdmitted(this.policy, { ...this.subject, row }, this.surface);
  }

  private wrap(inner: Builder<object>): RuleChecked {
    return new RuleChecked(inner, this.policy, this.subject, this.surface);
  }
}

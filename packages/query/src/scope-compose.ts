// Single responsibility: compose a `scoped()` policy's predicate into a read's source BEFORE the
// page is cut, so hidden rows never shorten a page — the JS rule stays the authority on every row
// the narrowed source returns (`ruleCheckOf`, `page-window.ts`). A tree (`or`/`via`) is read by
// `scope-tree.ts`.
import { policyScope } from '@ultimat3/policy';
import { QueryScopeUncomposableError } from './errors';
import type { QueryPolicy, QuerySubject, QuerySurface } from './policy-gate';
import { queryRowAdmitted } from './policy-gate';
import { filterOf } from './scope-tree';
import type { QueryShape, SeekKey } from './shape';
import type { SqlSource, SqlText } from './source';
import { Builder } from './source';

/**
 * `source` narrowed by the policy's scope for `subject.actor`, or `source` itself when the policy
 * declares none. A condition becomes an ordinary `.compare()` filter, so it reaches the SQL text, the
 * live matcher's shape and a provider's `RowWindow.filters` exactly as a `.where()` would; an `or`
 * group or a `via` hop becomes a node (`whereNode`), handed to a provider on `RowWindow.nodes`.
 *
 * Refused (`X_QUERY_SCOPE_UNCOMPOSABLE`) rather than guessed: a tree on a LIVE read (the matcher's
 * shape is flat), and a `via` over a list of rows, which has no statement to push the hop into.
 */
export function composeScope(
  source: SqlSource<object>,
  policy: QueryPolicy,
  subject: QuerySubject,
  surface: QuerySurface,
): SqlSource<object> {
  const nodes = policyScope(policy, subject.actor);
  if (nodes === undefined) return source;
  if (!(source instanceof Builder)) throw new QueryScopeUncomposableError(subject.query);
  const narrowed = nodes.reduce<Builder<object>>((builder, node) => {
    if (!('column' in node)) return builder.whereNode(node);
    const filter = filterOf(node);
    return builder.compare(filter.column, filter.op, filter.value);
  }, source);
  const tree = nodes.some((node) => !('column' in node));
  if (tree && surface === 'live') throw new QueryScopeUncomposableError(subject.query, 'live');
  if (narrowed.needsProvider && !narrowed.provides) {
    throw new QueryScopeUncomposableError(subject.query, 'rows');
  }
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

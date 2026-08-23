/**
 * How a byte budget is WRITTEN — `'40kb'` — and nothing else.
 *
 * It was the whole graph-based budget API: `Island`, `BundleGraph`, `graphFor`, `routeJsBytes`,
 * `checkBudget`, `checkBudgets`, `assertBudget`. Every one of them was exported from the barrel and
 * called by nothing outside this package's own tests. The real gate is `@ultimat3/cli`'s
 * `checkBudgets` (`packages/cli/src/budgets.ts`), which measures the EMITTED document against the
 * manifest's per-route `budget` and has its own `parseByteBudget` caller — the near-miss that made
 * the dead half look reached. Deleted 2026-08-23 rather than wired: two answers to "what does this
 * route weigh", one of which never ran, is the ambiguity axiom 1 refuses, and a build error nothing
 * calls is not a build error.
 *
 * `defaultIslandBudget` in `modes.ts` is the surviving half of the island-budget story: it is
 * reached, through `registerRoute`, and it is what puts a number on a route that declares none.
 */

const UNITS: Readonly<Record<string, number>> = { b: 1, kb: 1024, mb: 1024 * 1024 };

/** `'40kb'` → 40960. Throws nothing: an unparseable budget is `null` and skipped. */
export function parseByteBudget(budget: string | undefined): number | null {
  if (budget === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)$/i.exec(budget.trim());
  const amount = match?.[1];
  const unit = match?.[2]?.toLowerCase();
  if (amount === undefined || unit === undefined) return null;
  const factor = UNITS[unit];
  return factor === undefined ? null : Math.round(Number(amount) * factor);
}

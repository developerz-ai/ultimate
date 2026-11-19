// The rows a money sort is walked over, and the order it must serve them in — one copy for the
// memory driver and Postgres, so the two cannot hold different ideas of "currency, then minor".

type Price = { readonly currency: string; readonly minor: number } | null;

/** Two currencies, ties inside each, a minor that is larger in the currency that sorts first. */
export const MONEY_ROWS: readonly Price[] = [
  { currency: 'USD', minor: 100 },
  { currency: 'EUR', minor: 100 },
  null,
  { currency: 'EUR', minor: 5 },
  { currency: 'USD', minor: 50 },
  { currency: 'EUR', minor: 100 },
  { currency: 'USD', minor: 100 },
  null,
  { currency: 'EUR', minor: 100 },
  { currency: 'EUR', minor: 9000 },
];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The ids in the order the handle sorts them: NULL largest, then currency, minor, id. */
export function moneyOrder(
  rows: readonly { readonly id: string; readonly price: Price }[],
  direction: 'asc' | 'desc',
): readonly string[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.price === null || b.price === null) {
      return (a.price === null ? 1 : 0) - (b.price === null ? 1 : 0) || byCodeUnit(a.id, b.id);
    }
    return (
      byCodeUnit(a.price.currency, b.price.currency) ||
      a.price.minor - b.price.minor ||
      byCodeUnit(a.id, b.id)
    );
  });
  const ids = sorted.map((row) => row.id);
  return direction === 'asc' ? ids : ids.reverse();
}

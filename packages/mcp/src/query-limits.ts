// LAYER 4 of `db.query`'s four defences: what one agent-authored read may cost, and how much of
// it may come back. A cap the caller cannot raise, applied where the tool cannot forget it —
// `limit` is an argument, and an argument is a request, never a permission.

/** The ceilings. Frozen because a cap a caller can widen is a default, not a cap. */
export interface QueryLimits {
  /** Hard row ceiling. A larger `limit` argument is clamped, not honoured. */
  readonly maxRows: number;
  /** Ceiling on the serialised rows. Rows are cheap; a row of 2 MB of JSONB is not. */
  readonly maxBytes: number;
  /** `statement_timeout` for the read. 0 disables. */
  readonly timeoutMs: number;
}

export const QUERY_LIMITS: QueryLimits = Object.freeze({
  maxRows: 1000,
  // 256 KiB: the result lands in a model's context, and a tool that can fill it has denied the
  // agent the rest of its turn as surely as any error would.
  maxBytes: 256 * 1024,
  timeoutMs: 5_000,
});

/** What `limit` means when the caller does not send one. Well under the hard ceiling. */
export const DEFAULT_QUERY_ROWS = 100;

/** What the host hands back: rows plus the database-side defences that engaged. */
export interface QueryRows {
  readonly columns: readonly string[];
  /** One array per row, in `columns` order. Fetch `maxRows + 1` — see `capQueryRows`. */
  readonly rows: readonly (readonly unknown[])[];
  /** Guards from layers 1–2. The tool appends its own; nothing is inferred. */
  readonly guards: readonly string[];
}

/** What `db.query` answers. Every cap that bit says so; none of them is silent. */
export interface QueryResult extends QueryRows {
  readonly rowCount: number;
  readonly truncated: boolean;
  /** Which ceiling cut the result short, or `null` when nothing did. */
  readonly truncatedBy: 'rows' | 'bytes' | null;
  /** Bytes of JSON actually returned, so the next `limit` can be chosen rather than guessed. */
  readonly bytes: number;
}

/**
 * The ceilings for one call. A `limit` argument may only ever narrow them: below 1 is a typo,
 * above `maxRows` is a caller who read the schema's `maximum` as a suggestion.
 */
export function resolveQueryLimits(requested: unknown): QueryLimits {
  const asked =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.trunc(requested)
      : DEFAULT_QUERY_ROWS;
  return { ...QUERY_LIMITS, maxRows: Math.max(1, Math.min(QUERY_LIMITS.maxRows, asked)) };
}

const encoder = new TextEncoder();

/**
 * Serialised size of one row, plus the separator it costs inside the JSON array.
 *
 * A row the driver decoded into something JSON cannot hold — a bigint from an `int8` column, a
 * cycle — costs `Infinity`, which is not a fudge: the row cannot be returned to the agent at all,
 * and the ceiling it blows is already the one whose answer ("select fewer columns") is the right
 * one. Raising instead would take down the tool that owes the agent a reply, from inside the cap
 * that exists to protect it.
 */
function rowBytes(row: readonly unknown[]): number {
  try {
    return encoder.encode(JSON.stringify(row)).length + 1;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Apply the row and byte ceilings and say which one bit.
 *
 * The host fetches `maxRows + 1` rows: one row past the ceiling is how `truncated` is known
 * without a second count query, and it is dropped here.
 *
 * A single row larger than `maxBytes` yields zero rows and `truncatedBy: 'bytes'`. Returning it
 * anyway would make the byte cap a suggestion, and the honest answer tells the agent exactly
 * what to do next: select fewer columns.
 */
export function capQueryRows(source: QueryRows, limits: QueryLimits): QueryResult {
  const overRows = source.rows.length > limits.maxRows;
  const kept: (readonly unknown[])[] = [];
  let bytes = 2; // the enclosing `[]`
  let overBytes = false;

  for (const row of source.rows.slice(0, limits.maxRows)) {
    const size = rowBytes(row);
    if (bytes + size > limits.maxBytes) {
      overBytes = true;
      break;
    }
    kept.push(row);
    bytes += size;
  }

  return {
    columns: source.columns,
    rows: kept,
    rowCount: kept.length,
    truncated: overRows || overBytes,
    // Bytes first: it is the ceiling that cut this particular answer short, even when the row
    // ceiling would also have applied further down.
    truncatedBy: overBytes ? 'bytes' : overRows ? 'rows' : null,
    bytes,
    guards: [...source.guards, `cap:${limits.maxRows} rows`, `cap:${limits.maxBytes} bytes`],
  };
}

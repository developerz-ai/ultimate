// Test support: the ONE name a live or contract suite gives the database it creates and drops —
// prefix, pid, creation second (base 36), eight random hex characters. A fixed name let two runs against one server drop each
// other's database mid-suite (#705). Here, at tier 0, because every package with such a suite can
// import core and `@ultimat3/testing` (tier 5) is out of reach below it. `bun run probe-databases`.

/** Postgres's NAMEDATALEN - 1: a longer identifier is silently truncated, so two names could meet. */
export const PROBE_DATABASE_NAME_MAX = 63;

const RANDOM_HEX = 8;

/** Where a probe name's uniqueness comes from — injectable so a test can pin the answer. */
export interface ProbeDatabaseEntropy {
  /** Defaults to `process.pid`: two concurrent runs are two processes. */
  readonly pid?: number | undefined;
  /** Defaults to a fresh `crypto.randomUUID()`: two suites in one process differ by this. */
  readonly random?: string | undefined;
  /** Defaults to `Date.now()`: the creation second the sweep ages a leftover by. */
  readonly now?: number | undefined;
}

/** Lowercase `[a-z0-9_]`, starting with a letter or `_` — an identifier no statement must quote. */
function identifierPrefix(prefix: string): string {
  const folded = prefix.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (folded === '') return 'x_probe';
  return /^[a-z_]/.test(folded) ? folded : `x_${folded}`;
}

/**
 * A database name unique to this call, valid unquoted, at most 63 bytes — truncation takes the
 * prefix, never the suffix. The creation second is in the name because `pg_database` records none,
 * and `sweepProbeDatabases` must not drop a run's database in the moment between its `create` and
 * its first connection (`<prefix>_<pid>_<seconds, base 36>_<8 hex>`).
 */
export function probeDatabaseName(prefix: string, entropy: ProbeDatabaseEntropy = {}): string {
  const pid = Math.trunc(Math.abs(entropy.pid ?? process.pid));
  const hex = (entropy.random ?? crypto.randomUUID())
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '')
    .slice(0, RANDOM_HEX)
    .padEnd(RANDOM_HEX, '0');
  const seconds = Math.floor(Math.max(0, entropy.now ?? Date.now()) / 1000).toString(36);
  const suffix = `_${String(pid)}_${seconds}_${hex}`;
  return `${identifierPrefix(prefix).slice(0, PROBE_DATABASE_NAME_MAX - suffix.length)}${suffix}`;
}

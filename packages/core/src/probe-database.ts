// Test support: the ONE name a live or contract suite gives the database it creates and drops —
// prefix, pid, eight random hex characters. A fixed name let two runs against one server drop each
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
}

/** Lowercase `[a-z0-9_]`, starting with a letter or `_` — an identifier no statement must quote. */
function identifierPrefix(prefix: string): string {
  const folded = prefix.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (folded === '') return 'x_probe';
  return /^[a-z_]/.test(folded) ? folded : `x_${folded}`;
}

/**
 * A database name unique to this call, valid unquoted, at most 63 bytes — truncation takes the
 * prefix, never the pid and random part that make the name unique.
 */
export function probeDatabaseName(prefix: string, entropy: ProbeDatabaseEntropy = {}): string {
  const pid = Math.trunc(Math.abs(entropy.pid ?? process.pid));
  const hex = (entropy.random ?? crypto.randomUUID())
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '')
    .slice(0, RANDOM_HEX)
    .padEnd(RANDOM_HEX, '0');
  const suffix = `_${String(pid)}_${hex}`;
  return `${identifierPrefix(prefix).slice(0, PROBE_DATABASE_NAME_MAX - suffix.length)}${suffix}`;
}

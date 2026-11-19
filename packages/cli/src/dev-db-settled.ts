// The one thing `x dev` must do after its database's ledger moved under it — a migrate or a
// rollback applied through `/_x/db` — and nothing on disk changed for the watcher to see: build a
// generation, so the findings (`X_APP_MIGRATIONS_UNAPPLIED`) say what the ledger now says.

/** The file a ledger-triggered rebuild is reported under: the directory the pass read. */
export const LEDGER_MOVED_FILE = 'packages/db/migrations';

let rebuild: ((file: string) => void) | undefined;

/**
 * `devRebuilder` registers its own trigger: one `x dev` per process, so one slot, and the newest
 * rebuilder is the running one. A slot and not an import, because the route that applies the pass
 * is mounted before the rebuilder exists and neither module may import the other's graph.
 */
export function onLedgerMoved(trigger: (file: string) => void): void {
  rebuild = trigger;
}

/** Called by the `/_x/db` routes once a pass changed the ledger. No rebuilder, nothing to say. */
export function ledgerMoved(): void {
  rebuild?.(LEDGER_MOVED_FILE);
}

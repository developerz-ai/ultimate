// Single responsibility: the resync the replicator OWES the bus — set when its feed's slot was
// recreated under a resume position, paid by one publish, kept owed across runs until one lands.
// What the message is lives in `replication-resync.ts`; when it is said, in `replicator.ts`.

export class ResyncDebt<Run> {
  #owed: string | null = null;
  /** The publish in flight, per run: the boot and a change asking at once publish ONE resync. */
  #paying: { readonly run: Run; readonly paid: Promise<void> } | undefined;

  /** Owed until a publish lands — across runs, since the next run finds the slot there. */
  owe(reason: string): void {
    this.#owed = reason;
  }

  /** Publishes what is owed, if anything. A refusal rejects and leaves it owed. */
  pay(run: Run, publish: (reason: string) => Promise<void>): Promise<void> {
    const reason = this.#owed;
    if (reason === null) return Promise.resolve();
    if (this.#paying?.run === run) return this.#paying.paid;
    const paid = publish(reason)
      .then(() => {
        if (this.#owed === reason) this.#owed = null;
      })
      .finally(() => {
        if (this.#paying?.paid === paid) this.#paying = undefined;
      });
    this.#paying = { run, paid };
    return paid;
  }
}

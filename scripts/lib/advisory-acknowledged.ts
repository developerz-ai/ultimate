// The advisories a published range admits that no release of the declared dependency floors: each
// row acknowledges them until `expires`, so `advisory-floors.ts` reads them as known, never new.
// Past `expires` a row is X_ADVISORY_ACK_EXPIRED; a row the audit no longer needs is
// X_ADVISORY_ACK_STALE.
//
// why: a framework range cannot floor a dependency's own dependency. `overrides` reach an app's
// lockfile only, and a direct floor in the framework's manifest nests a patched copy beside the
// app's hoisted vulnerable one, a false green. The app's `bun update` is the floor until upstream
// raises its own.

/** One acknowledged exposure set: `advisories` in `via`, reached through `manifest`'s `dependency`. */
export interface AcknowledgedAdvisory {
  /** The published manifest that declares `dependency`, repo-relative. */
  readonly manifest: string;
  /** The declared dependency whose range admits the advisories. */
  readonly dependency: string;
  /** GHSA ids, each one an exposure the audit reports for this declaration. */
  readonly advisories: readonly string[];
  /** The packages the advisories are in, reached through `dependency` (itself, for its own). */
  readonly via: readonly string[];
  readonly reason: string;
  /** The command an app runs to take the patched versions into its own lockfile. */
  readonly appFix: string;
  /**
   * `YYYY-MM-DD`, UTC: the last day the row acknowledges anything. More than `ACK_MAX_DAYS` (90)
   * after the audit's day, or not a calendar day, and it acknowledges nothing (`lapseOf`).
   */
  readonly expires: string;
}

export const ADVISORY_ACKNOWLEDGED: readonly AcknowledgedAdvisory[] = [
  {
    manifest: 'packages/render/package.json',
    dependency: 'sass',
    advisories: ['GHSA-xvcm-6775-5m9r', 'GHSA-v56q-mh7h-f735', 'GHSA-68fv-2mgg-jv7q'],
    via: ['immutable', 'source-map-js'],
    reason:
      'every sass release declares immutable ^5.1.5 and source-map-js >=0.6.2 <2.0.0, which admit immutable < 5.1.8 and source-map-js < 1.2.2; the bun.lock of this repo already resolves the patched versions. Exit: sass raises both floors (issue #1221)',
    appFix: 'bun update immutable source-map-js',
    expires: '2027-02-25',
  },
];

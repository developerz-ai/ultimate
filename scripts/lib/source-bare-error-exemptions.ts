// The exemption inventory for the SOURCE scope of `scripts/test-bare-error.ts`: every
// intentional bare throw in shipped source, one row per site, with the reason it is there.
// Data only — the guard owns what it does with a row.
//
// WHY A LIST AND NOT A RULE. A fixture double that throws AT the subject is a test's INPUT, and
// this repo's rule says an input is never reported. A `*-fixture.ts` file is shipped source to
// every scope that reads the tree, so the source scope sees its throws and cannot tell them from
// a verdict by shape — the distinction is not textual, so it is written down here.
//
// ONE ROW PER SITE, never per file and never per package: a count let one exempt site be deleted
// and a real bare throw added in the same file with no number moving — the swap
// `scripts/secret-compare.ts` closed by grouping per site.
//
// A row that matches no site is a finding of its own: an exemption nobody reads is a licence the
// next throw inherits.

/** Where the inventory lives, so a finding can name the file a repair edits. */
export const SOURCE_BARE_ERROR_EXEMPTIONS_FILE = 'scripts/lib/source-bare-error-exemptions.ts';

/** One intentional bare throw in shipped source, and why it is there. */
export interface SourceBareErrorExemption {
  /** Repo-relative, POSIX separators. */
  readonly path: string;
  /** The line the throw is on. */
  readonly line: number;
  /** Why this site throws a bare Error and is not a verdict. */
  readonly reason: string;
}

export const SOURCE_BARE_ERROR_EXEMPTIONS: readonly SourceBareErrorExemption[] = [
  {
    path: 'packages/cli/e2e/client-navigation-fixture.ts',
    line: 359,
    reason:
      'the route under test writes and then fails, so what answers it is the framework own error page and not this throw',
  },
  {
    path: 'packages/pwa/src/service-worker-harness-fixture.ts',
    line: 94,
    reason:
      'the service-worker harness is all-or-nothing like the browser: a non-ok response refuses the whole install',
  },
  {
    path: 'packages/pwa/src/service-worker-harness-fixture.ts',
    line: 139,
    reason: 'the harness offline fetch, so a suite can drive the worker with no network at all',
  },
  {
    path: 'packages/render/src/navigation-dom-fixture.ts',
    line: 452,
    reason:
      'the fake DOMParser refuses a document no test registered, rather than answering an empty one the router would read as a page',
  },
  {
    path: 'packages/realtime/src/client-harness-fixture.ts',
    line: 159,
    reason:
      'what a browser throws when it refuses a new WebSocket: the fixture must be the real failure, not a framework error this code path can never produce',
  },
  {
    path: 'packages/realtime/src/pg-replication-fixture.ts',
    line: 360,
    reason:
      'the socket whose close() raises — the one way a teardown failure reaches a caller of start()',
  },
  {
    path: 'packages/storage/src/driver-s3-fixture.ts',
    line: 177,
    reason:
      'the fake S3 losing a signed answer: Bun fetch rejects a dropped socket with exactly this TypeError, and the driver under test must read that foreign error, not a coded one',
  },
  {
    path: 'packages/storage/src/driver-s3-fixture.ts',
    line: 390,
    reason:
      'the same fake dropping a write before it lands: the TypeError Bun fetch rejects with, handed to the driver under test',
  },
  {
    path: 'packages/storage/src/driver-s3-fixture.ts',
    line: 402,
    reason:
      'the same fake dropping the answer after the write landed: the TypeError Bun fetch rejects with, handed to the driver under test',
  },
];

// The ratchet under `scripts/proto-index.ts`: how many places in each package READ a `Record<…>`
// object literal with a computed key that is not a string literal. The number may FALL and may
// never rise. Data only.
//
// WHY A COUNT AND A SENTENCE. Every site pinned here is a claim that the key cannot be
// `constructor`, `toString` or `__proto__` — usually because its TYPE is a closed union the
// compiler checks. That claim holds exactly until the value arrives from a database row, an HTTP
// header or a JSON body, which is where all thirteen shipped instances came from. The sentence is
// where a human says which side of that line the package's tables sit on.
//
// Shrink it with `bun run scripts/proto-index.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PROTO_PINS_FILE = 'scripts/lib/proto-index-pins.ts';

export interface ProtoIndexPin {
  readonly count: number;
  readonly reason: string;
}

/**
 * Measured 2026-08-23, on the first run: 100 reads across 18 packages, after the sweep that fixed
 * thirteen by hand. The residue is overwhelmingly one shape — a closed-key table indexed by a value
 * whose declared TYPE is the key union — which TypeScript checks and which becomes a defect the day
 * the value stops being typed and starts being parsed.
 */
export const PROTO_INDEX_PINS: Readonly<Record<string, ProtoIndexPin>> = {
  admin: {
    count: 9,
    reason:
      '`permissions.ts`, `fields.ts` and `dev/data.ts` index closed tables by an `AdminOperation`, a `FieldType`, a `ColumnKind` and a run/step status. Three of the thirteen shipped instances were in `admin/dev/`, so this is the package to drain first.',
  },
  auth: {
    count: 3,
    reason:
      '`verify.ts` indexes by a `VerificationPurpose` and `tokens.ts` by a base64url character its own regex produced. Three of the thirteen were here.',
  },
  cli: {
    count: 7,
    reason:
      '`cmd-build.ts`, `generate-files.ts`, `verify-tests.ts`, `static-report.ts`, `app-boundaries.ts` and `mcp-errors.ts` index by a target, a surface, a test type, a boundary rule and an `X_*` code — each a union the CLI parsed and narrowed before the read.',
  },
  core: {
    count: 8,
    reason:
      "closed tables keyed by a role, a lifecycle phase and an environment. `context.ts:203` was the worst of the thirteen — `useService('constructor')` answered the `Object` function out of the function whose job is throwing `X_SERVICE_MISSING` — and it is repaired; the rest are compiler-checked unions.",
  },
  db: {
    count: 4,
    reason:
      '`client.ts`, `errors.ts`, `sqlstate.ts` and `sql-noise.ts` index by a pool role and a SQLSTATE. `sqlstate.ts:100` reads a code that came off the WIRE, and is the one here closest to being a real defect again. The fifth was the column-kind read, which moved out of `generate.ts` into `sql-type.ts` and is now guarded rather than pinned — a bare index answered the `Object` function for the kind `constructor` and spliced its source into the type position of an alter statement.',
  },
  entity: {
    count: 4,
    reason:
      '`n-plus-one.ts`, `errors.ts` and `array-element.ts` index fix tables by a bulk-write op and an array element kind, both narrowed from the entity registry.',
  },
  jobs: {
    count: 1,
    reason:
      'one closed table keyed by a job lifecycle state the worker itself set one statement earlier.',
  },
  mail: {
    count: 4,
    reason: 'MIME header and encoding tables keyed by a union this package declares.',
  },
  pwa: {
    count: 1,
    reason: '`strategies.ts:66` maps a route `RenderMode` to a caching strategy.',
  },
  render: {
    count: 7,
    reason:
      'render-mode, surface and hydration tables, each keyed by a member of a vocabulary `scripts/render-modes.ts` already refuses a second copy of.',
  },
  scripts: {
    count: 38,
    reason:
      'the gate scripts themselves: `FINDINGS[gap.kind]` in every ratchet, a table keyed by a union the same file declares one line above and narrows exhaustively. Not shipped to an app, and the key never crosses a process boundary. It went 36 -> 38 when the two newest ratchets landed, which is the honest cost of keeping one shape across twenty guards rather than one guard shaped differently.',
  },
  seo: {
    count: 2,
    reason:
      '`xml.ts` escapes a character its own regex matched. `images.ts` was one of the thirteen and is repaired.',
  },
  testing: {
    count: 4,
    reason:
      'fixture tables keyed by a driver name and a bracket character, both from closed lists this package owns.',
  },
  time: { count: 1, reason: '`duration.ts:52` scales by a duration unit this package declares.' },
  ui: {
    count: 4,
    reason:
      'token and widget tables keyed by a semantic role. `fake-dom.ts:79` was one of the thirteen — `querySelectorAll("[constructor]")` matched every element — and is repaired.',
  },
};

/** What this package is allowed to have today. Absent means zero, deliberately. */
export const protoIndexPinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, ProtoIndexPin>> = PROTO_INDEX_PINS,
): number => (Object.hasOwn(pins, pkg) ? (pins[pkg]?.count ?? 0) : 0);

/**
 * The edit `X_PROTO_CHAIN_INDEX_PIN_STALE` names, performed: lower each named package's count to
 * what is measured, and refuse to raise one. Returns the entries it changed.
 */
export async function applyProtoIndexUnpin(
  root: string,
  packages: readonly string[],
  counts: Readonly<Record<string, number>>,
  pins: Readonly<Record<string, ProtoIndexPin>> = PROTO_INDEX_PINS,
): Promise<readonly string[]> {
  const path = `${root}/${PROTO_PINS_FILE}`;
  let text = await Bun.file(path).text();
  const written: string[] = [];
  for (const pkg of packages) {
    const found = counts[pkg] ?? 0;
    if (found >= protoIndexPinnedFor(pkg, pins)) continue;
    // `RegExp.escape`, never the raw key: a name holding regex syntax matches a NEIGHBOURING row.
    const key = RegExp.escape(pkg);
    if (found === 0) {
      // The whole entry, reason and all — a row claiming a debt of zero reads as a rule still in
      // force over nothing. Both spellings Biome writes: `{ count: 1, reason: '…' }` on one line
      // and the wrapped form.
      const entry = new RegExp(`^\\s*(['"]?)${key}\\1:\\s*\\{[\\s\\S]*?\\},\\n`, 'm');
      if (!entry.test(text)) continue;
      text = text.replace(entry, '');
    } else {
      const entry = new RegExp(`^(\\s*(['"]?)${key}\\2:\\s*\\{\\s*\\n?\\s*count:\\s*)\\d+,`, 'm');
      if (!entry.test(text)) continue;
      text = text.replace(entry, `$1${String(found)},`);
    }
    written.push(`${pkg} -> ${String(found)}`);
  }
  if (written.length > 0) await Bun.write(path, text);
  return written;
}

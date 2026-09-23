// The one per-package ratchet: sites grouped by package, compared against a pins table, answered
// as over / stale / unexplained / unscanned gaps — and `--unpin`, the edit a stale gap names. Eight
// guards each carried their own copy of all of it (a gap union, a `*PinnedFor`, a regex
// `apply*Unpin`, a counts walk, a two-branch main), and the copies had drifted: three read a pin's
// `reason` and five did not. What stays in a guard is what is its own — the scanner and the words.

import { flagList, parseScriptArgs } from './args';
import type { Finding } from './log';
import { report } from './log';
import { repoRoot } from './run';
import { ScriptError } from './script-error';

/** A package's allowance: a bare count, or a count that must carry the sentence saying why. */
export type Pin = number | { readonly count: number; readonly reason: string };
export type PinTable = Readonly<Record<string, Pin>>;

export type GapKind = 'over' | 'stale' | 'unscanned' | 'unexplained';

export interface RatchetGap<S> {
  readonly kind: GapKind;
  readonly pkg: string;
  readonly found: number;
  readonly pinned: number;
  readonly first?: S;
}

/** `packages/<pkg>/…` is `<pkg>`; anything else is its top directory (`scripts`, `examples`). */
export const packageOf = (path: string): string =>
  path.startsWith('packages/') ? (path.split('/')[1] ?? path) : (path.split('/')[0] ?? path);

/** A row that exists with a blank reason: its count is not honoured, and the gap says which row. */
export const pinIsBlank = (pkg: string, pins: PinTable): boolean => {
  if (!Object.hasOwn(pins, pkg)) return false;
  const pin = pins[pkg];
  return typeof pin === 'object' && pin.reason.trim() === '';
};

/** What `pkg` may hold today. Absent means zero, and so does a row with a blank reason. */
export const pinnedFor = (pkg: string, pins: PinTable): number => {
  if (!Object.hasOwn(pins, pkg) || pinIsBlank(pkg, pins)) return 0;
  const pin = pins[pkg];
  return typeof pin === 'number' ? pin : (pin?.count ?? 0);
};

/** Sites per package, for `--unpin` and for the number a maintainer wants when lowering one. */
export function siteCounts<S extends { readonly path: string }>(
  sites: readonly S[],
  groupOf: (site: S) => string = (site) => packageOf(site.path),
): Readonly<Record<string, number>> {
  // A `Map`: a package name is data, and `counts['constructor']` on a literal reads a prototype.
  const counts = new Map<string, number>();
  for (const site of sites) counts.set(groupOf(site), (counts.get(groupOf(site)) ?? 0) + 1);
  return Object.fromEntries(counts);
}

/**
 * The ratchet itself: a package may hold what it is pinned at, may fall, may never rise. `scanned`
 * false is a corpus that read nothing, which reads exactly like a clean tree — so it is a gap.
 */
export function ratchetGaps<S extends { readonly path: string }>(
  sites: readonly S[],
  pins: PinTable,
  scanned: boolean,
  groupOf: (site: S) => string = (site) => packageOf(site.path),
): readonly RatchetGap<S>[] {
  if (!scanned) return [{ kind: 'unscanned', pkg: '', found: 0, pinned: 0 }];
  const found = new Map<string, S[]>();
  for (const site of sites) {
    const pkg = groupOf(site);
    found.set(pkg, [...(found.get(pkg) ?? []), site]);
  }
  const gaps: RatchetGap<S>[] = [];
  for (const pkg of new Set([...found.keys(), ...Object.keys(pins)])) {
    const hits = found.get(pkg) ?? [];
    const pinned = pinnedFor(pkg, pins);
    // A blank reason waives nothing: reported in its own right, AND its count is not honoured.
    if (pinIsBlank(pkg, pins)) gaps.push({ kind: 'unexplained', pkg, found: hits.length, pinned });
    const first = hits[0];
    if (hits.length > pinned) {
      gaps.push({ kind: 'over', pkg, found: hits.length, pinned, ...(first ? { first } : {}) });
    } else if (hits.length < pinned) {
      gaps.push({ kind: 'stale', pkg, found: hits.length, pinned });
    }
  }
  return gaps.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
}

/**
 * The edit a stale gap names, performed on the pins file's TEXT: lower each named package to what
 * is measured, delete a row that reaches zero, and refuse to raise one. Both row shapes Biome
 * writes — `pkg: 3,` and `pkg: {\n count: 3,\n reason: '…',\n },` — and quoted keys, whose spelling
 * is captured and written back. `RegExp.escape`, never the raw key: `a.b` must not match `axb`.
 */
export async function applyUnpin(
  root: string,
  pinsFile: string,
  packages: readonly string[],
  counts: Readonly<Record<string, number>>,
  pins: PinTable,
): Promise<readonly string[]> {
  const path = `${root}/${pinsFile}`;
  let text = await Bun.file(path).text();
  const written: string[] = [];
  for (const pkg of packages) {
    const found = counts[pkg] ?? 0;
    if (found >= pinnedFor(pkg, pins)) continue;
    const key = `(?<q>['"]?)${RegExp.escape(pkg)}\\k<q>`;
    const flat = new RegExp(`^(\\s*${key}:\\s*)\\d+,\\n`, 'm');
    const nested = new RegExp(`^(\\s*${key}:\\s*\\{\\s*count:\\s*)\\d+,`, 'm');
    // One line (`{ count: 1, reason: '…' },`) or wrapped, with the brace closing on its own line.
    const whole = new RegExp(`^\\s*${key}:\\s*\\{(?:[^\\n]*\\},|[\\s\\S]*?\\n\\s*\\},)\\n`, 'm');
    const before = text;
    if (flat.test(text)) {
      text = found === 0 ? text.replace(flat, '') : text.replace(flat, `$1${String(found)},\n`);
    } else if (nested.test(text)) {
      text = found === 0 ? text.replace(whole, '') : text.replace(nested, `$1${String(found)},`);
    }
    if (text !== before) written.push(`${pkg} -> ${String(found)}`);
  }
  if (written.length > 0) await Bun.write(path, text);
  return written;
}

/** What a guard supplies: its scanner over the tree, its words, and where its pins live. */
export interface RatchetSpec<S extends { readonly path: string }> {
  readonly script: string;
  readonly pinsFile: string;
  readonly pins: PinTable;
  readonly sites: (root: string) => Promise<readonly S[]>;
  readonly findingFor: (gap: RatchetGap<S>) => Finding;
  readonly clean: string;
  readonly groupOf?: (site: S) => string;
}

/** The two things a guard's command does: report the ratchet, or `--unpin` it. */
export async function ratchetMain<S extends { readonly path: string }>(
  spec: RatchetSpec<S>,
): Promise<never> {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  let sites: readonly S[];
  try {
    sites = await spec.sites(root);
  } catch (error) {
    // `X_CORPUS_UNSCANNED`, reported on the same three lines as any finding and never exit 0.
    if (!(error instanceof ScriptError)) throw error;
    return report(
      { ok: false, script: spec.script, summary: 'refused', findings: [error.toFinding()] },
      args.json,
    );
  }
  const counts = siteCounts(sites, spec.groupOf);
  const unpin = flagList(args, 'unpin');
  if (unpin.length > 0) {
    const lowered = await applyUnpin(root, spec.pinsFile, unpin, counts, spec.pins);
    return report(
      {
        ok: true,
        script: spec.script,
        summary:
          lowered.length === 0
            ? 'nothing to lower — every named package is already at what this tree measures'
            : `lowered ${String(lowered.length)} pin(s): ${lowered.join(', ')}`,
        findings: [],
      },
      args.json,
    );
  }
  const gaps = ratchetGaps(sites, spec.pins, true, spec.groupOf);
  return report(
    {
      ok: gaps.length === 0,
      script: spec.script,
      summary:
        gaps.length === 0
          ? spec.clean
          : `${String(gaps.length)} package(s) off the ${spec.script} ratchet`,
      findings: gaps.map(spec.findingFor),
      // `--explain` lists every site: the number a maintainer wants before lowering a pin.
      data: { counts, ...(args.flags.get('explain') === true ? { sites } : {}) },
    },
    args.json,
  );
}

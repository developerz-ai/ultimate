// The script's own reading surfaces, over the tree it runs on: how a window log is split, what
// `--settle-hours` accepts, and the one JSON envelope a bot branches on. Split from
// `release-due.test.ts`, which owns the release window itself and is at its filesize ceiling, so
// the pure readers are not also the file that builds a repository per test.
//
// These three read no git and no GitHub: the parser and the flag reader are pure, and the
// envelope test runs the SCRIPT for real — which is the point of it, the one surface a consumer
// of `scripts/release-due.ts --json` actually sees.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
// why: the mask is how a scan reads code — a comment or a quoted sentence is not a declaration.
import { maskLiterals } from '../packages/core/src/source-mask';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import { parseWindowLog, settleHoursOf } from './release-due';

// The envelope test runs the script against the real tree, so it contends with every other
// `scripts/` suite under `--parallel` — the repo-scan backstop, not Bun's 5000ms default.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/**
 * Every refusal `decideAt` can hand back as a `Finding` on a real checkout: a tagless shallow
 * clone, a window the log could not read, HEAD not at the base ref's tip, or the publish floor.
 * One list, so a refusal code added to `release-due.ts` cannot slip past the closed set this
 * suite pins.
 *
 * `X_CORPUS_UNSCANNED` is an INTENTIONAL structured refusal, not a hole in the guard: the
 * publish floor (`publishFloorFindings`, `scripts/lib/workspaces.ts`) is what `decideAt` RETURNS
 * when the tree it read enumerates no publishable workspace — a tree read from the wrong place,
 * never a release with nothing to do. It travels the same `findings[]` channel as every other
 * refusal, so the closed set has to name it: a closed set that omitted a code `decideAt` really
 * returns would send the envelope test red on a checkout that is not the repository's.
 */
const REFUSAL_CODES = [
  'X_RELEASE_TAG_UNREACHABLE',
  'X_RELEASE_WINDOW_UNREADABLE',
  'X_RELEASE_HEAD_NOT_MAIN',
  'X_CORPUS_UNSCANNED',
] as const;
type RefusalCode = (typeof REFUSAL_CODES)[number];

describe('unit · release-due · parsing and flags', () => {
  test('the window log splits on control characters, so a subject may hold anything', () => {
    const log = '\x1eabc\x1f100\x1fdependabot[bot]\x1fchore: a | b\n\npackages/core/package.json\n';
    expect(parseWindowLog(log)).toEqual([
      {
        sha: 'abc',
        committedAt: 100,
        author: 'dependabot[bot]',
        subject: 'chore: a | b',
        files: ['packages/core/package.json'],
      },
    ]);
    expect(parseWindowLog('')).toEqual([]);
  });

  test('--settle-hours takes a number of hours at or above zero, and nothing else', () => {
    expect(settleHoursOf(undefined)).toBe(24);
    expect(settleHoursOf('0')).toBe(0);
    expect(settleHoursOf('1.5')).toBe(1.5);
    for (const bad of ['-1', 'soon', '', 'Infinity']) {
      const refused = settleHoursOf(bad);
      expect({ bad, code: typeof refused === 'number' ? refused : refused.code }).toEqual({
        bad,
        code: 'X_CLI_BAD_FLAG',
      });
    }
  });

  test('--json on the real tree is one envelope a bot can branch on', async () => {
    const out = await run(['bun', 'run', 'scripts/release-due.ts', '--json'], {
      cwd: repoRoot(),
    });
    const parsed = JSON.parse(out.output) as {
      ok: boolean;
      script: string;
      data?: { due: boolean; lastTag: string; reason?: string; headSha?: string };
      findings?: readonly { code: RefusalCode }[];
    };
    expect(parsed.script).toBe('release-due');
    // A refusal carries no `data`: every signal a bot branches on is in `findings`. The codes
    // are a closed set — a tagless shallow checkout (TAG_UNREACHABLE), a hung git log
    // (WINDOW_UNREADABLE), HEAD not at origin/main's tip (HEAD_NOT_MAIN), or a tree with no
    // publishable workspace (CORPUS_UNSCANNED, the publish floor) — so a real-tree run on a
    // side branch, or on a checkout that is not the repository's, keeps the suite green
    // instead of mismatching the prior exact match. The set is pinned against the source in
    // the describe below; this test only asks that what arrived is one of them.
    if (!parsed.ok) {
      expect(parsed.data).toBeUndefined();
      for (const finding of parsed.findings ?? []) {
        expect(REFUSAL_CODES).toContain(finding.code);
      }
      return;
    }
    expect(typeof parsed.data?.due).toBe('boolean');
    expect(parsed.data?.lastTag).toMatch(/^v\d+\.\d+\.\d+$/);
    // The concrete anchor for the consumer: HEAD's SHA at the moment decideAt ran.
    expect(parsed.data?.headSha).toMatch(/^[0-9a-f]{40}$/);
    if (!parsed.data?.due) expect(parsed.data?.reason).toBeDefined();
  });
});

/**
 * The two files that hold every code `decideAt` can hand back: the script itself, and the
 * publish floor it asks. No other module in the decision's call chain declares a code —
 * `release-due-git.ts`, `release-due-gh.ts` and `base-ref.ts` answer with values, not refusals
 * — so a code added anywhere else is a code some other script's set owns.
 */
const SCANNED_SOURCES = ['scripts/release-due.ts', 'scripts/lib/workspaces.ts'] as const;

/**
 * A top-level declaration: `export`, `async` and the kind, then the name. The pattern is
 * anchored at the START OF A LINE because a top-level declaration sits at column 0 and a
 * nested one is indented — that is what "top-level" means in a formatted TypeScript file, and
 * it is why a nested function's literal is never credited to the declaration around it.
 */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:async\s+)?(?:const|function|let|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * The span of a top-level declaration: its start to the NEXT top-level declaration, or the end
 * of the file. The span is what "the body of this function" means here, and the next
 * declaration is where the body ends — a brace count cannot say so, because a return TYPE may
 * carry its own braces (`decideAt`'s `Promise<{ … } | Finding>` does) and a `{` in a type is not
 * a block.
 */
const declarationSpan = (masked: string, name: string): readonly [number, number] | undefined => {
  const declaration = new RegExp(
    `^(?:export\\s+)?(?:async\\s+)?(?:const|function|let|class)\\s+${name}\\b`,
    'm',
  );
  const found = declaration.exec(masked);
  if (found === null) return undefined;
  const start = found.index;
  const rest = masked.slice(start + 1);
  const next = /^(?:export\s+)?(?:async\s+)?(?:const|function|let|class)\s+[A-Za-z_$]/m.exec(rest);
  return [start, next === null ? masked.length : start + 1 + next.index];
};

/** Every name called inside a declaration's span. */
const callsIn = (masked: string, name: string): readonly string[] => {
  const span = declarationSpan(masked, name);
  if (span === undefined) return [];
  return [...masked.slice(span[0], span[1]).matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map(
    (match) => match[1] ?? '',
  );
};

/**
 * The top-level declaration that owns the position `at`: the nearest one above it, kept only
 * when the braces say the position is still inside it. The depth is what makes it more than a
 * name search — a literal in a NESTED function must not be credited to the outer one.
 */
const enclosingDeclaration = (masked: string, at: number): string | undefined => {
  const declarations = [...masked.matchAll(TOP_LEVEL_DECLARATION)];
  let nearest: { name: string; start: number } | undefined;
  for (const declaration of declarations) {
    const start = declaration.index ?? 0;
    if (start > at) continue;
    nearest = { name: declaration[1] ?? '', start };
  }
  if (nearest === undefined) return undefined;
  let depth = 0;
  for (let i = nearest.start; i < at; i += 1) {
    const character = masked[i];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
  }
  return depth > 0 ? nearest.name : undefined;
};

/**
 * The object literal that owns the `code:` property at `at`: the `{` that opens it, found by
 * walking back out of whatever is nested inside, and its matching `}` found by walking forward.
 */
const ownerBlock = (masked: string, at: number): readonly [number, number] | undefined => {
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    const character = masked[i];
    if (character === '}') depth += 1;
    else if (character === '{') {
      if (depth === 0) {
        let open = 0;
        for (let j = i; j < masked.length; j += 1) {
          const inner = masked[j];
          if (inner === '{') open += 1;
          else if (inner === '}') {
            open -= 1;
            if (open === 0) return [i, j + 1];
          }
        }
        return undefined;
      }
      depth -= 1;
    }
  }
  return undefined;
};

/**
 * Every name `decideAt` can reach, transitively, across the scanned files: its own calls, then
 * theirs. The transitive closure is what keeps a producer two hops away in the set — the
 * publish floor is asked for by name, but a future refusal factory might not be.
 */
const reachableFrom = (masked: ReadonlyMap<string, string>): ReadonlySet<string> => {
  const reachable = new Set<string>(['decideAt']);
  const pending = ['decideAt'];
  while (pending.length > 0) {
    const name = pending.pop() ?? '';
    for (const source of masked.values()) {
      if (declarationSpan(source, name) === undefined) continue;
      for (const called of callsIn(source, name)) {
        if (reachable.has(called)) continue;
        reachable.add(called);
        pending.push(called);
      }
    }
  }
  return reachable;
};

/**
 * The codes `decideAt` can RETURN as a `Finding`, read off the source rather than declared.
 *
 * Two questions decide every `code:` literal in the scanned files:
 *
 * 1. Is it THROWN? A `throw new ScriptError({ code: … })` is an exception, not a refusal the
 *    envelope carries — `decideAt` never returns it, so it is not a code in `findings[]`. The
 *    literal has to be the DIRECT argument of the `throw` to count as thrown: the publish floor
 *    sits in the same file as a throw and is returned anyway.
 * 2. Is its producer REACHABLE? `X_CLI_BAD_FLAG` is returned by `settleHoursOf`, a flag reader
 *    the script calls BEFORE `decideAt` runs — so it is a flag refusal, never a decision
 *    refusal, and it must stay out of the set `decideAt` answers with.
 *
 * A code that answers "no" to either question is not in the set; a code `decideAt` really can
 * return is. The scan reads the mask, so a code named in a COMMENT or quoted inside a longer
 * string is not counted — only a `code:` property whose value is the code itself.
 */
interface CodeSite {
  /** The code the literal holds. */
  readonly code: string;
  /** The file the literal is in, repo-relative. */
  readonly path: string;
  /** The 1-based line the literal is on. */
  readonly line: number;
  /** The top-level declaration the literal sits in, when one owns it. */
  readonly owner: string | undefined;
  /** Whether the literal is the DIRECT argument of a `throw new ScriptError(`. */
  readonly thrown: boolean;
  /** Whether the owner is reachable from `decideAt`, transitively. */
  readonly reachable: boolean;
  /** Whether the code is therefore one `decideAt` can RETURN as a `Finding`. */
  readonly kept: boolean;
}

/**
 * Every `code:` literal in the scanned files, with the three facts that decide it. The
 * attribution is what the suite PINS: a scanner that stopped finding the code's own object
 * literal, or that stopped telling a thrown code from a returned one, would change the kept
 * set — and a change in the kept set is the failure this whole suite exists to catch.
 *
 * `kept` is the conjunction the scan applies: a code is kept when it is NOT thrown and its
 * owner IS reachable from `decideAt`. Both facts are reported for every literal, kept or not,
 * so a dropped code can be read as dropped for the reason it was dropped.
 */
const scanCodeSites = async (): Promise<readonly CodeSite[]> => {
  const sources = new Map<string, string>();
  const raw = new Map<string, string>();
  for (const path of SCANNED_SOURCES) {
    const source = await Bun.file(join(repoRoot(), path)).text();
    raw.set(path, source);
    sources.set(path, maskLiterals(source));
  }
  const reachable = reachableFrom(sources);
  const sites: CodeSite[] = [];
  for (const [path, masked] of sources) {
    const source = raw.get(path) ?? '';
    for (const match of masked.matchAll(/code: '/g)) {
      const at = match.index ?? -1;
      const close = masked.indexOf("'", at + 7);
      if (close === -1) continue;
      const code = source.slice(at + 7, close);
      if (!/^X_[A-Z0-9_]+$/.test(code)) continue;
      const owner = enclosingDeclaration(masked, at);
      const block = ownerBlock(masked, at);
      const thrown =
        block !== undefined && /throw new ScriptError\(\s*$/.test(masked.slice(0, block[0]));
      const isReachable = owner !== undefined && reachable.has(owner);
      sites.push({
        code,
        path,
        line: source.slice(0, at).split('\n').length,
        owner,
        thrown,
        reachable: isReachable,
        kept: !thrown && isReachable,
      });
    }
  }
  return sites;
};

const decideAtRefusalCodes = async (): Promise<readonly string[]> => {
  const sites = await scanCodeSites();
  return [...new Set(sites.filter((site) => site.kept).map((site) => site.code))].sort();
};

describe('unit · release-due · the closed set of refusals matches the code', () => {
  test('the declared set covers exactly the codes decideAt can return as a Finding', async () => {
    const scanned = await decideAtRefusalCodes();
    // A scan that found nothing would pass a set comparison against an empty set in silence —
    // and an empty set is the one answer that proves nothing.
    expect(
      scanned.length,
      'the scan read no codes at all, so it would agree with any declared set',
    ).toBeGreaterThan(0);
    expect(
      scanned,
      'the codes decideAt can return have drifted from the declared closed set — add the new code to REFUSAL_CODES, or take it out of the refusal path',
    ).toEqual([...REFUSAL_CODES].sort());
  });

  test('the publish floor is a refusal decideAt returns, not a thrown error', async () => {
    // The one that started this: `decideAt` RETURNS the publish floor (`publishFloorFindings`),
    // so its code travels `findings[]` — but the declared set did not name it, which left the
    // envelope test free to go red on a tree that is not the repository's.
    const scanned = await decideAtRefusalCodes();
    expect(scanned).toContain('X_CORPUS_UNSCANNED');
    expect(REFUSAL_CODES).toContain('X_CORPUS_UNSCANNED');
  });

  test('the flag reader is not a refusal decideAt can return', async () => {
    // `settleHoursOf` refuses a bad `--settle-hours` BEFORE `decideAt` runs, so its code is
    // never in the envelope's `findings[]` — the closed set is a decision's, not the CLI's.
    const scanned = await decideAtRefusalCodes();
    expect(scanned).not.toContain('X_CLI_BAD_FLAG');
    expect(REFUSAL_CODES).not.toContain('X_CLI_BAD_FLAG');
  });
});

describe('unit · release-due · the scanner is pinned to the source shapes it reads', () => {
  /**
   * Every `code:` literal in the two scanned files, and the three facts that decide whether
   * `decideAt` can RETURN it. This is the scanner's own inventory, pinned against the REAL
   * sources: a new code literal in either file cannot appear without this list changing, and a
   * literal that moves cannot change owner, thrown or reachable without this list changing.
   *
   * The kept set alone would not say that: a scanner that found the wrong object literal, or
   * that mistook a returned code for a thrown one, could still produce the same four codes.
   * The ATTRIBUTION is what says which literal is which.
   */
  test('every code literal in the scanned files is attributed as the source says', async () => {
    const sites = await scanCodeSites();
    // `path | code | owner | thrown | reachable`, one row per literal.
    expect(
      sites.map((site) => [site.path, site.code, site.owner, site.thrown, site.reachable]),
      'a code literal in scripts/release-due.ts or scripts/lib/workspaces.ts was added, moved, or re-attributed — the closed set and this inventory are both stale',
    ).toEqual([
      ['scripts/release-due.ts', 'X_RELEASE_WINDOW_UNREADABLE', 'gitUnreadable', false, true],
      ['scripts/release-due.ts', 'X_RELEASE_TAG_UNREACHABLE', 'unreachable', false, true],
      ['scripts/release-due.ts', 'X_RELEASE_HEAD_NOT_MAIN', 'headNotMain', false, true],
      ['scripts/release-due.ts', 'X_CLI_BAD_FLAG', 'settleHoursOf', false, false],
      ['scripts/release-due.ts', 'X_CORPUS_UNSCANNED', 'decideAt', true, true],
      [
        'scripts/lib/workspaces.ts',
        'X_WORKSPACE_MANIFEST_UNREADABLE',
        'requireWorkspaceManifest',
        true,
        true,
      ],
      ['scripts/lib/workspaces.ts', 'X_CORPUS_UNSCANNED', 'publishFloorFindings', false, true],
    ]);
  });

  test('the kept set follows from the attribution, not from the set of codes', async () => {
    const sites = await scanCodeSites();
    // The rule the scan applies, spelled out over the pinned inventory: a code is kept when
    // it is NOT thrown and its owner IS reachable. Asserted as a derivation so the two
    // independent pins — the attribution and the kept set — cannot drift apart.
    const derived = sites.filter((site) => !site.thrown && site.reachable).map((site) => site.code);
    expect([...new Set(derived)].sort()).toEqual([...REFUSAL_CODES].sort());
    expect(sites.filter((site) => site.kept).map((site) => site.code)).toEqual(derived);
  });

  test('a thrown code is dropped by the throw rule, not by unreachability', async () => {
    // The sharpest case in the tree: `X_CORPUS_UNSCANNED` is BOTH thrown (in `decideAt`, the
    // broken-invariant guard) and returned (by the publish floor). The two sites are told apart
    // by the throw rule alone — `ownerBlock` has to find each code's OWN object literal, and
    // the thrown one has to be the DIRECT argument of the `throw new ScriptError(`.
    //
    // `X_WORKSPACE_MANIFEST_UNREADABLE` is the mirror: it IS reachable from `decideAt`
    // (`listWorkspaces` asks for it), so nothing but the throw rule keeps it out of the set.
    const sites = await scanCodeSites();
    const thrownOnes = sites.filter((site) => site.thrown).map((site) => site.code);
    expect(thrownOnes.sort()).toEqual(['X_CORPUS_UNSCANNED', 'X_WORKSPACE_MANIFEST_UNREADABLE']);
    for (const site of sites.filter((site) => site.thrown)) {
      expect(
        site.reachable,
        `${site.code} at ${site.path}:${site.line} is dropped for being thrown — if it were also unreachable the throw rule would be untested`,
      ).toBe(true);
    }
    // And the returned half of the same code is reachable AND not thrown: the publish floor.
    const floor = sites.find(
      (site) => site.code === 'X_CORPUS_UNSCANNED' && site.path === 'scripts/lib/workspaces.ts',
    );
    expect(floor).toBeDefined();
    expect(floor?.thrown).toBe(false);
    expect(floor?.reachable).toBe(true);
  });

  test('the closed-set comparison fails on a code added to or removed from the set', async () => {
    // The comparison the suite rests on has to actually FAIL when the declared set and the
    // source drift. `toEqual` on two sorted lists does — but a test that only ever compares
    // the two REAL lists cannot tell a comparison that fails from one that would pass on
    // anything. So the comparison is exercised against MUTATED copies of the declared set:
    // one with a code added, one with a code removed. Both must disagree with the scanned
    // set, and the empty scan must disagree with every declared set — the vacuous pass the
    // whole scan exists to prevent.
    const scanned = await decideAtRefusalCodes();
    const declared = [...REFUSAL_CODES].sort();
    expect(scanned.length, 'the scan read no codes at all').toBeGreaterThan(0);

    const added = [...declared, 'X_NOT_A_REAL_CODE'].sort();
    const removed = declared.filter((code) => code !== REFUSAL_CODES[0]);
    expect(added, 'a code added to the declared set must not match the scanned set').not.toEqual(
      scanned,
    );
    expect(
      removed,
      'a code removed from the declared set must not match the scanned set',
    ).not.toEqual(scanned);
    // The vacuous pass: an empty scan agrees with an EMPTY declared set and with nothing
    // else — so the guard against it has to be the length check, and that check has to be
    // here, not merely assumed.
    expect([], 'an empty scan must not satisfy the declared set').not.toEqual(scanned);
    expect(declared.length, 'the declared set must not be empty either').toBeGreaterThan(0);
  });

  test('an unreachable code is dropped by the reachability rule, not by the throw rule', async () => {
    // `X_CLI_BAD_FLAG` is returned, never thrown — so the throw rule cannot be what keeps it
    // out of the set. `settleHoursOf` is a flag reader the script calls BEFORE `decideAt`
    // runs, so `decideAt` never reaches it. If the reachability filter ever stopped
    // separating it, the flag refusal would join the decision's closed set and the envelope
    // test would go red on a real tree.
    const sites = await scanCodeSites();
    const flag = sites.find((site) => site.code === 'X_CLI_BAD_FLAG');
    expect(flag).toBeDefined();
    expect(flag?.thrown).toBe(false);
    expect(flag?.reachable).toBe(false);
    expect(flag?.kept).toBe(false);
  });
});

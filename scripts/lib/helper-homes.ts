// The helpers that live in exactly one module, and the SHAPE of a second implementation of each —
// plus a second import PATH (`package-reexports.ts`: a package's value republished by another;
// `export-all.ts`: a blind `export *` that rule could not see through). Every row replaced copies
// that had already drifted — four HTML escape sets, three cookie readers, four `PgExecutor`s — and
// is enforced by `bun run flight-copies` (`X_HELPER_COPY`).

import { maskLiterals, stripComments } from '../../packages/core/src/source-mask';
import { exportAllViolations } from './export-all';
import type { Finding } from './log';
import { packageReexportViolations } from './package-reexports';
import { lineOf } from './source-scan';

export interface HelperSource {
  readonly at: string;
  readonly text: string;
}

/** Both views a rule may read: string contents blanked (`masked`) or kept (`stripped`). */
interface Views {
  readonly masked: string;
  readonly stripped: string;
}

export interface HelperHome {
  /** The exported name the copy should have imported. */
  readonly helper: string;
  /** The one module allowed to implement it. */
  readonly home: string;
  /** Offsets of every copy in a file — each rule decides which view it reads. */
  readonly find: (views: Views) => readonly number[];
}

const offsets = (text: string, pattern: RegExp): number[] =>
  [...text.matchAll(pattern)].map((match) => match.index);

/** Offsets of `first` that have `second` within `window` characters after them. */
const near = (text: string, first: RegExp, second: RegExp, window: number): number[] =>
  offsets(text, first).filter((index) => second.test(text.slice(index, index + window)));

/**
 * FNV-1a's offset basis and prime, as VALUES: `0x811c_9dc5`, `2166136261` and `0x811C9DC5` are one
 * number, and a rule spelled on one of them reads straight past the other two.
 */
const FNV_CONSTANTS: ReadonlySet<number> = new Set([2_166_136_261, 16_777_619]);
const NUMERIC = /\b(?:0[xX][0-9a-fA-F_]+|\d[\d_]*)\b/g;
const fnvConstants = ({ masked }: Views): number[] =>
  [...masked.matchAll(NUMERIC)]
    .filter((match) => FNV_CONSTANTS.has(Number(match[0].replaceAll('_', ''))))
    .map((match) => match.index);

/** A replacement that WRITES `&amp;` — a map value or a replace argument — never one that reads it. */
const AMP_WRITTEN = /[:,]\s*(['"`])&amp;\1/g;

/** The `PgExecutor` method DECLARED (`;`), never implemented (`{`) — a test fake is the latter. */
const PG_EXECUTOR_METHOD =
  /\bquery\s*<\s*\w+\s*>\s*\(\s*\w+\s*:\s*string\s*,\s*\w+\s*:\s*readonly\s+unknown\s*\[\s*\]\s*\)\s*:\s*Promise\s*<\s*readonly\s+\w+\s*\[\s*\]\s*>\s*;/g;

export const HELPER_HOMES: readonly HelperHome[] = [
  { helper: 'fnv1a', home: 'packages/core/src/fnv1a.ts', find: fnvConstants },
  {
    helper: 'fingerprint',
    home: 'packages/core/src/canonical-json.ts',
    // UNKEYED: one argument. `CryptoHasher('sha256', key)` over canonicalJson is an HMAC —
    // `keyedFingerprint`, the persisted form, a different helper with its own reason to exist.
    find: ({ masked }) =>
      near(masked, /\bCryptoHasher\s*\(\s*[^,()]*\)/g, /\bcanonicalJson\s*\(/, 200),
  },
  {
    helper: 'contentHash',
    home: 'packages/render/src/render-static.ts',
    // `stripped`: the copy in `revalidated-response.ts` sat inside a template literal's `${…}`,
    // which the masked view blanks along with the string around it.
    find: ({ stripped }) => offsets(stripped, /\bhash\s*\.\s*xxHash32\s*\(/g),
  },
  {
    helper: 'escapeHtml',
    home: 'packages/core/src/html-escape.ts',
    find: ({ stripped }) => offsets(stripped, AMP_WRITTEN),
  },
  {
    helper: 'readCookie',
    home: 'packages/core/src/cookie.ts',
    // The `name=value` walk itself, decoded or not: the two tier-2 copies decoded in a helper
    // further down the file, so a rule demanding `decodeURIComponent` beside the split read past both.
    find: ({ stripped }) =>
      near(
        stripped,
        /\.split\(\s*(['"`]);\1\s*\)/g,
        /\.indexOf\(\s*(['"`])=\1\s*\)|\bdecodeURIComponent\s*\(/,
        300,
      ),
  },
  {
    helper: 'PgExecutor',
    home: 'packages/core/src/pg-executor.ts',
    find: ({ masked }) => [
      ...offsets(masked, /\b(?:interface|type)\s+PgExecutor\b/g),
      ...offsets(masked, PG_EXECUTOR_METHOD),
    ],
  },
  {
    helper: 'storeMode',
    home: 'packages/core/src/store-mode.ts',
    // `stripped`, so a scaffold TEMPLATE writing the ternary into a generated app is caught too.
    find: ({ stripped }) =>
      offsets(stripped, /\bresolveEnvironment\s*\([^)]*\)\s*===\s*(['"`])test\1\s*\?/g),
  },
  {
    helper: 'renderDeprecation',
    home: 'packages/core/src/deprecation.ts',
    // `stripped`: both signals are string CONTENTS — the RFC 8288 relation the successor link
    // carries, and RFC 9745's `@<unix seconds>` Date. action and query each carried a twin of it.
    find: ({ stripped }) => [
      ...offsets(stripped, /\brel\s*=\s*\\?["']?successor-version\b/g),
      ...offsets(stripped, /`@\$\{\s*Math\s*\.\s*floor\s*\(/g),
    ],
  },
  {
    helper: 'BUILD_ID_HEADER',
    home: 'packages/core/src/page-meta.ts',
    // `stripped`: the defect is the string. Four modules spelled it and `@ultimat3/http` made it
    // configurable besides, so a server could listen for a header no client of it sent. The meta
    // is the same spelling by construction (`BUILD_ID_HEADER = CLIENT_BUILD_META`), so one literal.
    find: ({ stripped }) => offsets(stripped, /(['"`])x-ultimate-build\1/g),
  },
];

const finding = (file: HelperSource, rule: HelperHome, index: number): Finding => {
  const from = rule.home.startsWith('packages/core/')
    ? '@ultimat3/core'
    : '@ultimat3/render/server';
  return {
    code: 'X_HELPER_COPY',
    cause: `${file.at}:${lineOf(file.text, index)} is a second ${rule.helper} — ${rule.home} is its one implementation, and copies of it had already drifted apart`,
    fix: `import { ${rule.helper} } from '${from}' and delete the local implementation in ${file.at}`,
    at: file.at,
  };
};

/**
 * One finding per helper per file, at its first copy, in source order: a basis and a prime two
 * lines apart are ONE FNV-1a, and the fix — import the helper, delete the local one — is per file.
 * A rule's own home is never reported.
 */
export function checkHelperHomes(file: HelperSource): readonly Finding[] {
  const views: Views = { masked: maskLiterals(file.text), stripped: stripComments(file.text) };
  const hits: { readonly rule: HelperHome; readonly index: number }[] = [];
  for (const rule of HELPER_HOMES) {
    if (rule.home === file.at) continue;
    const found = rule.find(views);
    if (found.length > 0) hits.push({ rule, index: Math.min(...found) });
  }
  return [
    ...hits.sort((a, b) => a.index - b.index).map((hit) => finding(file, hit.rule, hit.index)),
    ...packageReexportViolations(file),
    ...exportAllViolations(file),
  ];
}
